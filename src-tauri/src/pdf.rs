/*!
PDF → JPEG 渲染（hayro，纯 Rust）。

设计取舍：

- **一份 PDF = 一位考生**。PDF 里的所有页都属于同一份卷子（第 1 页选择题、第 2 页大题），
  批改时把这些页一起送给模型，所以这里只负责"把每页变成一张图片"，不参与任务拆分。
- **渲染结果落盘缓存**，而不是只在内存里传。好处有两个：前端 `<img>` 走 asset 协议就能预览
  （`<img>` 根本显示不了 PDF）；重新批改同一张卷子时不用再渲染一遍。
- **尺寸由「长边上限」驱动**（默认 2048），不再按 dpi 渲染：视觉模型自己也只有
  1568~2048 的处理能力，渲到 300 dpi 再被模型缩一次等于白烧 CPU 和带宽。
- **缓存键含长边与黑白开关**：老师换档位后旧缓存自然失效，不会拿旧图糊弄。
- hayro 自述"实验性"，遇到畸形 PDF 可能 panic，所以每页渲染都套 `catch_unwind`：
  单页炸掉只让这份卷子失败，不能带崩整批。
*/

use crate::imaging::{self, ImageOptions};
use anyhow::{anyhow, bail, Context, Result};
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::{LoadPdfError, Pdf};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{render, PixmapSettings, RenderCache, RenderSettings};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// 单份 PDF 的页数上限。超过基本是"全班扫描件合成一个 PDF"，逐页渲染会吃掉几分钟。
pub const MAX_PAGES: usize = 40;

/// 单页像素上限（≈60MP）。超过就等比降采样，避免 u16 溢出和内存爆掉。
const MAX_PIXELS_PER_PAGE: f32 = 60_000_000.0;

/// 放大倍数的天花板。小尺寸 PDF 页面（裁切过的扫描件）需要放大才能看清，
/// 但放大不产生信息，超过 4 倍纯属浪费。
const MAX_UPSCALE: f32 = 4.0;

/// 「这份 PDF 是不是全白」的判定线，取得极低（0.001%），只用来抓"一个像素都没画出来"
/// 的静默失败。任何真内容 —— 哪怕只有一行表头 —— 都远高于这条线。
const MIN_INK_RATIO: f64 = 0.00001;

/// 缓存格式版本：编码方式或尺寸策略变了就加一，老缓存自然失效。
const CACHE_VERSION: u32 = 3;

pub fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

fn open(path: &Path) -> Result<Pdf> {
    let bytes = std::fs::read(path).with_context(|| format!("读取 PDF 失败：{}", path.display()))?;
    if bytes.is_empty() {
        bail!("PDF 是空文件：{}", path.display());
    }
    Pdf::new(bytes).map_err(|e| match e {
        // hayro 明确不支持加密文档（文档里写死了），这里给出能照做的提示
        LoadPdfError::Decryption(_) => anyhow!(
            "PDF 已加密，无法读取：{}。请先用阅读器另存为不加密的 PDF",
            path.display()
        ),
        LoadPdfError::Invalid => anyhow!(
            "PDF 结构损坏或不是有效的 PDF：{}",
            path.display()
        ),
    })
}

/// 页数（只解析结构，不渲染）。扫描文件夹时用它填列表里的「N 页」。
pub fn page_count(path: &Path) -> Result<usize> {
    let pdf = open(path)?;
    let n = pdf.pages().len();
    if n == 0 {
        bail!("PDF 里没有页面：{}", path.display());
    }
    Ok(n)
}

/// 缓存目录：`<root>/pdf/<hash>-<长边>-<g|c>/`，hash 覆盖「路径 + 修改时间 + 大小 +
/// 长边上限 + 黑白开关」。文件被覆盖、或老师换了画质档位，都会自动换目录。
fn cache_dir(pdf: &Path, opts: &ImageOptions, cache_root: &Path) -> PathBuf {
    let meta = std::fs::metadata(pdf).ok();
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.map(|m| m.len()).unwrap_or(0);

    let mut h = std::collections::hash_map::DefaultHasher::new();
    pdf.to_string_lossy().to_lowercase().hash(&mut h);
    mtime.hash(&mut h);
    size.hash(&mut h);
    opts.long_edge().hash(&mut h);
    opts.grayscale.hash(&mut h);
    CACHE_VERSION.hash(&mut h);

    let mode = if opts.grayscale { "g" } else { "c" };
    cache_root.join(format!("{:016x}-{}-{mode}", h.finish(), opts.long_edge()))
}

/// 渲染全部页到 JPEG 缓存，返回图片绝对路径（顺序即页码）。
///
/// `on_page(done, total)` 用于给老师显示「正在渲染 PDF 第 3/5 页」。
pub fn render_pages(
    pdf_path: &Path,
    opts: &ImageOptions,
    cache_root: &Path,
    on_page: &mut dyn FnMut(usize, usize),
) -> Result<Vec<String>> {
    let out_dir = cache_dir(pdf_path, opts, cache_root);

    let pdf = open(pdf_path)?;
    let pages = pdf.pages();
    let total = pages.len();
    if total == 0 {
        bail!("PDF 里没有页面：{}", pdf_path.display());
    }
    if total > MAX_PAGES {
        bail!(
            "这份 PDF 有 {total} 页，超过单份 {MAX_PAGES} 页的上限 —— \
             系统按「一份 PDF 一位考生」设计，请确认没有把全班扫描件合成一个文件"
        );
    }

    let wanted: Vec<PathBuf> = (1..=total)
        .map(|i| out_dir.join(format!("page-{i:04}.jpg")))
        .collect();

    // 缓存命中：全部页都在就直接返回，切回上一张时不重新渲染
    if wanted.iter().all(|p| p.is_file()) {
        return Ok(wanted
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect());
    }

    std::fs::create_dir_all(&out_dir)
        .with_context(|| format!("创建 PDF 缓存目录失败：{}", out_dir.display()))?;

    let cache = RenderCache::new();
    let interpreter = InterpreterSettings::default();
    let render_settings = RenderSettings::default();

    let mut out: Vec<String> = Vec::with_capacity(total);
    let mut max_ink_ratio: f64 = 0.0;
    for (idx, page) in pages.iter().enumerate() {
        let (w, h) = page.render_dimensions();
        if w <= 0.0 || h <= 0.0 {
            bail!("第 {} 页尺寸异常（{w}×{h}）", idx + 1);
        }

        // 缩放倍数直接由「目标长边」决定，不再走 dpi：模型那边本来也只吃
        // 1568~2048 的长边，渲染到 300dpi 再被人缩一次是白烧 CPU 和带宽。
        let mut scale = match opts.long_edge() {
            0 => 1.0,
            edge => edge as f32 / w.max(h),
        };
        scale = scale.min(MAX_UPSCALE);
        let pixels = w * scale * h * scale;
        if pixels > MAX_PIXELS_PER_PAGE {
            scale *= (MAX_PIXELS_PER_PAGE / pixels).sqrt();
        }

        let pixmap_settings = PixmapSettings {
            x_scale: scale,
            y_scale: scale,
            // 白底：PDF 页面本身是透明的，直接存 RGBA 会让模型看到黑/透明背景
            bg_color: WHITE,
        };

        let pixmap = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            render(
                page,
                &cache,
                &interpreter,
                &render_settings,
                &pixmap_settings,
            )
        }))
        .map_err(|_| anyhow!("第 {} 页渲染失败（PDF 内容不受支持）", idx + 1))?;

        let (pw, ph) = (pixmap.width(), pixmap.height());
        if pw == 0 || ph == 0 {
            bail!("第 {} 页渲染结果为空", idx + 1);
        }

        let mut rgba = pixmap.data_as_u8_slice().to_vec();
        unpremultiply(&mut rgba);

        // 扫描件是"照片"，PNG 存它是纯浪费；黑白卷转灰度又能再省一半。
        // 顺手统计非白像素占比：用来兜住"图没解出来 → 整页空白"这种静默失败。
        let gray = opts.grayscale;
        let channels = if gray { 1 } else { 3 };
        let mut pixels: Vec<u8> = Vec::with_capacity(rgba.len() / 4 * channels);
        let mut ink: u64 = 0;
        for px in rgba.chunks_exact(4) {
            const PAPER: u8 = 240;
            let (r, g, b) = (px[0], px[1], px[2]);
            if r < PAPER || g < PAPER || b < PAPER {
                ink += 1;
            }
            if gray {
                // BT.601 亮度，和 image crate 的 to_luma8 同源
                let y = (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32) as u8;
                pixels.push(y);
            } else {
                pixels.extend_from_slice(&[r, g, b]);
            }
        }
        let ink_ratio = ink as f64 / (pw as f64 * ph as f64);
        max_ink_ratio = max_ink_ratio.max(ink_ratio);

        let target = &wanted[idx];
        let jpeg = imaging::encode_jpeg(&pixels, pw as u32, ph as u32, gray)?;
        std::fs::write(target, &jpeg)
            .with_context(|| format!("写入 PDF 页面图片失败：{}", target.display()))?;

        out.push(target.to_string_lossy().to_string());
        on_page(idx + 1, total);
    }

    // hayro 解不出的图像编码（比如某些 JBIG2 变体）不会报错，只是那一页画不出来 ——
    // 整份都白就得当失败处理，否则模型会照着一张白纸给出"字迹不清、0 分"的成绩。
    // 单页空白是允许的（答题卡背面本来就可能是空白页）。
    if max_ink_ratio < MIN_INK_RATIO {
        let _ = std::fs::remove_dir_all(&out_dir);
        bail!(
            "这份 PDF 渲染后几乎是空白（非白像素最多的页也只有 {:.3}%）—— \
             PDF 里的图像编码可能不受支持，或扫描件本身是空白页：{}",
            max_ink_ratio * 100.0,
            pdf_path.display()
        );
    }

    Ok(out)
}

/// vello 输出的是预乘 alpha 的 RGBA8，要先还原成直通 alpha 再去掉 alpha 通道。
/// 白底渲染后 alpha 基本都是 255，这一步只处理半透明边缘，避免出现灰边。
fn unpremultiply(buf: &mut [u8]) {
    for px in buf.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 0 {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
        } else if a < 255 {
            for c in 0..3 {
                px[c] = ((px[c] as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小可用 PDF：一页 200×200pt 的空白页（手写字节，不依赖外部文件）
    const BLANK_PDF: &str = "%PDF-1.7
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aigs-pdf-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一份"纯图片 PDF"：整页只有一张 JPEG（扫描件最常见的形态），
    /// 没有文本层、没有字体。手写字节拼 PDF 结构，图片流原样塞进去。
    fn build_image_pdf(jpeg: &[u8], img_w: u32, img_h: u32, page_pt: f32) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(b"%PDF-1.7\n");
        out.extend_from_slice(b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
        out.extend_from_slice(b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
        out.extend_from_slice(
            format!(
                "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 {page_pt} {page_pt}]\
                 /Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n"
            )
            .as_bytes(),
        );
        out.extend_from_slice(
            format!(
                "4 0 obj<</Type/XObject/Subtype/Image/Width {img_w}/Height {img_h}\
                 /ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length {}>>stream\n",
                jpeg.len()
            )
            .as_bytes(),
        );
        out.extend_from_slice(jpeg);
        out.extend_from_slice(b"\nendstream\nendobj\n");

        // 把图片铺满整页
        let content = format!("q {page_pt} 0 0 {page_pt} 0 0 cm /Im0 Do Q");
        out.extend_from_slice(
            format!(
                "5 0 obj<</Length {}>>stream\n{}\nendstream\nendobj\n",
                content.len(),
                content
            )
            .as_bytes(),
        );
        out.extend_from_slice(b"trailer<</Root 1 0 R>>\n%%EOF\n");
        out
    }

    fn opts(edge: u32, gray: bool) -> ImageOptions {
        ImageOptions {
            long_edge: edge,
            grayscale: gray,
            passthrough: false,
        }
    }

    #[test]
    fn pure_image_pdf_renders_page_content() {
        // 纯色 JPEG 64×64，铺满 200×200pt 的页面
        let rgb = image::RgbImage::from_pixel(64, 64, image::Rgb([200, 40, 60]));
        let mut jpeg: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgb8(rgb)
            .write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .unwrap();

        let dir = temp_dir("pure-image");
        let p = dir.join("scan.pdf");
        std::fs::write(&p, build_image_pdf(&jpeg, 64, 64, 400.0)).unwrap();

        assert_eq!(page_count(&p).unwrap(), 1);

        // 400pt 的页面按长边 800 渲染 → 放大 2 倍
        let pages = render_pages(&p, &opts(800, false), &dir.join("cache"), &mut |_, _| {}).unwrap();
        let img = image::open(&pages[0]).unwrap();
        assert_eq!((img.width(), img.height()), (800, 800));

        // 图片确实画上了：中心像素应该是那个红色，而不是白底
        let px = img.to_rgb8().get_pixel(400, 400).0;
        assert!(px[0] > 150 && px[1] < 90 && px[2] < 110, "中心像素：{px:?}");
    }

    #[test]
    fn grayscale_output_is_single_channel_and_smaller() {
        let dir = temp_dir("gray");
        let p = write_red_page(&dir, "scan.pdf");

        let color = render_pages(&p, &opts(800, false), &dir.join("c"), &mut |_, _| {}).unwrap();
        let gray = render_pages(&p, &opts(800, true), &dir.join("g"), &mut |_, _| {}).unwrap();

        let color_img = image::open(&color[0]).unwrap();
        let gray_img = image::open(&gray[0]).unwrap();
        assert!(matches!(gray_img, image::DynamicImage::ImageLuma8(_)));
        // 灰度单通道，体积必须更小
        let color_kb = std::fs::metadata(&color[0]).unwrap().len();
        let gray_kb = std::fs::metadata(&gray[0]).unwrap().len();
        assert!(gray_kb < color_kb, "色彩 {color_kb} vs 灰度 {gray_kb}");
        assert_eq!(color_img.width(), gray_img.width());
    }

    #[test]
    fn detects_pdf_by_extension() {
        assert!(is_pdf(Path::new("a.PDF")));
        assert!(is_pdf(Path::new("答题卡.pdf")));
        assert!(!is_pdf(Path::new("a.png")));
    }

    /// 极小的页面不能无限放大（放大不产生信息，只会烧内存）
    #[test]
    fn tiny_page_is_not_upscaled_beyond_limit() {
        let dir = temp_dir("tiny");
        let p = write_red_page_sized(&dir, "tiny.pdf", 50.0);
        let pages = render_pages(&p, &opts(2048, true), &dir.join("cache"), &mut |_, _| {}).unwrap();
        let img = image::open(&pages[0]).unwrap();
        // 50pt × MAX_UPSCALE(4) = 200 像素
        assert_eq!(img.width(), 200);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_file_reports_readable_error() {
        let dir = temp_dir("broken");
        let p = dir.join("bad.pdf");
        std::fs::write(&p, b"not a pdf at all").unwrap();
        let err = page_count(&p).unwrap_err().to_string();
        assert!(err.contains("PDF"), "实际错误：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 造一份有内容的单页 PDF（整页一张红图），用于验证渲染/缓存/尺寸。
    /// 页面取 400pt：长边 800 → 放大 2 倍，长边 1600 → 放大 4 倍，都在放大上限内。
    fn write_red_page(dir: &Path, name: &str) -> PathBuf {
        write_red_page_sized(dir, name, 400.0)
    }

    fn write_red_page_sized(dir: &Path, name: &str, page_pt: f32) -> PathBuf {
        let rgb = image::RgbImage::from_pixel(64, 64, image::Rgb([200, 40, 60]));
        let mut jpeg: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgb8(rgb)
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        let p = dir.join(name);
        std::fs::write(&p, build_image_pdf(&jpeg, 64, 64, page_pt)).unwrap();
        p
    }

    /// 整份渲染成空白 = 图像没解出来，必须报错而不是把白纸送去批改
    #[test]
    fn fully_blank_pdf_is_rejected() {
        let dir = temp_dir("blank");
        let p = dir.join("blank.pdf");
        std::fs::write(&p, BLANK_PDF).unwrap();

        let cache = dir.join("cache");
        let err = render_pages(&p, &opts(400, true), &cache, &mut |_, _| {})
            .unwrap_err()
            .to_string();
        assert!(err.contains("空白"), "实际错误：{err}");
        // 空白缓存必须清掉，否则第二次会直接命中缓存返回白图
        let err2 = render_pages(&p, &opts(400, true), &cache, &mut |_, _| {})
            .unwrap_err()
            .to_string();
        assert!(err2.contains("空白"), "第二次仍然应该报错：{err2}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renders_one_page_and_reuses_cache() {
        let dir = temp_dir("render");
        let p = write_red_page(&dir, "scan.pdf");
        assert_eq!(page_count(&p).unwrap(), 1);

        let cache = dir.join("cache");
        let mut calls = 0;
        let pages = render_pages(&p, &opts(1600, true), &cache, &mut |done, total| {
            assert_eq!(total, 1);
            calls = done;
        })
        .unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(calls, 1);
        assert!(Path::new(&pages[0]).is_file());

        // 400pt 的页面按长边 1600 渲染 → 1600×1600
        let img = image::open(&pages[0]).unwrap();
        assert_eq!((img.width(), img.height()), (1600, 1600));

        // 第二次应当命中缓存，不再回调节数
        let mut again = 0;
        let pages2 = render_pages(&p, &opts(1600, true), &cache, &mut |d, _| again = d).unwrap();
        assert_eq!(again, 0);
        assert_eq!(pages, pages2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn different_quality_uses_different_cache_dir() {
        let dir = temp_dir("quality");
        let p = write_red_page(&dir, "scan.pdf");
        let cache = dir.join("cache");

        let small = render_pages(&p, &opts(800, true), &cache, &mut |_, _| {}).unwrap();
        let large = render_pages(&p, &opts(1600, true), &cache, &mut |_, _| {}).unwrap();
        assert_ne!(small[0], large[0]);
        assert_eq!(image::open(&large[0]).unwrap().width(), 1600);

        // 黑白/彩色也必须落在不同目录，否则切开关会读到旧图
        let color = render_pages(&p, &opts(800, false), &cache, &mut |_, _| {}).unwrap();
        assert_ne!(small[0], color[0]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A4 竖版 + 一行 Helvetica 正文：验证长边换算、字体管线与最终体积
    const A4_TEXT_PDF: &str = "%PDF-1.7
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 44>>stream
BT /F1 24 Tf 72 700 Td (Grading) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF
";

    #[test]
    fn a4_page_renders_at_default_long_edge() {
        let dir = temp_dir("a4");
        let p = dir.join("a4.pdf");
        std::fs::write(&p, A4_TEXT_PDF).unwrap();

        let t0 = std::time::Instant::now();
        let pages = render_pages(
            &p,
            &ImageOptions::default(),
            &dir.join("cache"),
            &mut |_, _| {},
        )
        .unwrap();
        println!("A4 长边 2048 单页渲染耗时：{:?}", t0.elapsed());

        let img = image::open(&pages[0]).unwrap();
        // 842pt 是长边 → 2048；595/842 × 2048 ≈ 1447
        assert_eq!((img.width(), img.height()), (1447, 2048));
        // 默认档（灰度 q82）下，一页几乎空白的卷子也必须远小于网关上限
        let bytes = std::fs::metadata(&pages[0]).unwrap().len();
        assert!(bytes < 200 * 1024, "单页 {} KB", bytes / 1024);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_file_is_rejected() {
        let dir = temp_dir("empty");
        let p = dir.join("empty.pdf");
        std::fs::write(&p, b"").unwrap();
        assert!(page_count(&p).unwrap_err().to_string().contains("空文件"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
