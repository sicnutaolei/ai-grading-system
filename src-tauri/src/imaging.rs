/*!
上传前的图片瘦身：解码 → 黑白 → 缩到长边上限 → JPEG q82。

为什么要压：

- 视觉模型自己就有分辨率上限（Claude 4.6 长边 1568 / 1.15MP；OpenAI `detail:high`
  先缩到 2048 见方再把短边压到 768）。300 dpi 的 A4 是 2479×3508（8.69MP），
  多出来的像素模型根本看不到，只是白占上行带宽和内存。
- 黑白答题卡三个通道数据完全相同，转灰度直接省掉 2/3 的原始数据。

默认档（灰度 + 长边 2048 + q82）对模型而言是无损的：OpenAI 本来就要 2048，
Claude 还会自己再缩一档。而字节数通常只有"原样 RGB q88"的四分之一。

三个例外要记住：
1. 已经够小（≤300 KB）且尺寸达标的图**原样发**，避免二次压缩；
2. 用户开了「原图直传」就什么都不做（连解码都省了）；
3. 彩色开关关掉时保留三通道 —— 红笔批注这类信息有时候是判分依据。
*/

use crate::models::ApiConfig;
use anyhow::{bail, Context, Result};
use image::{DynamicImage, ImageEncoder};

/// 长边上限的默认值与可选范围。「2048 清晰 / 1568 标准 / 1200 省流」三档来自前端。
pub const DEFAULT_LONG_EDGE: u32 = 2048;
pub const MIN_LONG_EDGE: u32 = 800;
pub const MAX_LONG_EDGE: u32 = 4096;

/// 上传质量。q82 是文档扫描的甜点：比扫描仪自己存的 q75~85 还高。
pub const JPEG_QUALITY: u8 = 82;
/// 超限兜底质量（几乎不会触发：压到这个尺寸后一页通常 150~400 KB）
const FALLBACK_QUALITY: u8 = 60;
/// 单张图片体积警戒线
pub const MAX_IMAGE_BYTES: u64 = 6 * 1024 * 1024;
/// 小到不需要动的阈值：再压一次只会损失画质
const PASSTHROUGH_BYTES: u64 = 300 * 1024;

/// 一张卷子的图片处理参数（图片与 PDF 页共用同一套）
#[derive(Debug, Clone, Copy)]
pub struct ImageOptions {
    pub long_edge: u32,
    pub grayscale: bool,
    pub passthrough: bool,
}

impl ImageOptions {
    pub fn from_config(cfg: &ApiConfig) -> Self {
        Self {
            long_edge: cfg.image_long_edge,
            grayscale: cfg.image_grayscale,
            passthrough: cfg.image_passthrough,
        }
    }

    /// 夹到合理区间；0 视为"不缩放"（给测试和极端场景留的口子）
    pub fn long_edge(&self) -> u32 {
        if self.long_edge == 0 {
            0
        } else {
            self.long_edge.clamp(MIN_LONG_EDGE, MAX_LONG_EDGE)
        }
    }

    /// 用于进度文案，例如「长边 2048 · 黑白」
    pub fn describe(&self) -> String {
        if self.passthrough {
            "原图直传".to_string()
        } else if self.long_edge() == 0 {
            format!("{}", if self.grayscale { "原始尺寸 · 黑白" } else { "原始尺寸 · 彩色" })
        } else {
            format!(
                "长边 {} · {}",
                self.long_edge(),
                if self.grayscale { "黑白" } else { "彩色" }
            )
        }
    }
}

impl Default for ImageOptions {
    fn default() -> Self {
        Self {
            long_edge: DEFAULT_LONG_EDGE,
            grayscale: true,
            passthrough: false,
        }
    }
}

/// 处理结果。`Passthrough` 说明字节没动过，调用方要用原始 MIME。
pub enum Prepared {
    Passthrough(Vec<u8>),
    Jpeg(Vec<u8>),
}

impl Prepared {
    pub fn data(&self) -> &[u8] {
        match self {
            Self::Passthrough(b) | Self::Jpeg(b) => b,
        }
    }

    pub fn is_passthrough(&self) -> bool {
        matches!(self, Self::Passthrough(_))
    }
}

/// 把一张图片处理成可以直传模型的字节。
pub fn normalize(bytes: &[u8], opts: &ImageOptions) -> Result<Prepared> {
    if bytes.is_empty() {
        bail!("图片是空文件");
    }
    // 逃生门：连解码都不做，一个字节都不改
    if opts.passthrough {
        return Ok(Prepared::Passthrough(bytes.to_vec()));
    }

    let img = image::load_from_memory(bytes)
        .context("图片解码失败（支持 png / jpg / webp / bmp）")?;
    let long = img.width().max(img.height());
    let already_gray = matches!(img, DynamicImage::ImageLuma8(_) | DynamicImage::ImageLumaA8(_));

    // 本来就不大、尺寸也够、又不要求转灰度 —— 原样发，别做无谓的二次压缩
    let fits = opts.long_edge() == 0 || long <= opts.long_edge();
    let color_ok = !opts.grayscale || already_gray;
    if fits && color_ok && bytes.len() as u64 <= PASSTHROUGH_BYTES {
        return Ok(Prepared::Passthrough(bytes.to_vec()));
    }

    let img = flatten_if_alpha(img);
    let img = fit_long_edge(img, opts.long_edge());

    let jpeg = if opts.grayscale {
        let g = img.to_luma8();
        encode_jpeg(g.as_raw(), g.width(), g.height(), true)?
    } else {
        let rgb = img.to_rgb8();
        encode_jpeg(rgb.as_raw(), rgb.width(), rgb.height(), false)?
    };
    Ok(Prepared::Jpeg(jpeg))
}

/// 带白底合成：扫描件偶尔是带 alpha 的 PNG，直接丢 alpha 会得到黑底。
fn flatten_if_alpha(img: DynamicImage) -> DynamicImage {
    if !img.color().has_alpha() {
        return img;
    }
    let rgba = img.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (dst, px) in rgb.pixels_mut().zip(rgba.pixels()) {
        let a = px[3] as u32;
        let mix = |c: u8| -> u8 { ((c as u32 * a + 255 * (255 - a)) / 255).min(255) as u8 };
        *dst = image::Rgb([mix(px[0]), mix(px[1]), mix(px[2])]);
    }
    DynamicImage::ImageRgb8(rgb)
}

/// 等比缩到长边不超过 `long_edge`（不放大：放大不会增加任何信息）
fn fit_long_edge(img: DynamicImage, long_edge: u32) -> DynamicImage {
    if long_edge == 0 {
        return img;
    }
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    if long <= long_edge {
        return img;
    }
    let scale = long_edge as f32 / long as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
}

/// JPEG 编码（带超限降质兜底）。`gray = true` 时 data 是单通道 L8。
pub fn encode_jpeg(data: &[u8], w: u32, h: u32, gray: bool) -> Result<Vec<u8>> {
    let mut bytes = encode_jpeg_at(data, w, h, gray, JPEG_QUALITY)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        if let Ok(smaller) = encode_jpeg_at(data, w, h, gray, FALLBACK_QUALITY) {
            if smaller.len() < bytes.len() {
                bytes = smaller;
            }
        }
    }
    Ok(bytes)
}

fn encode_jpeg_at(data: &[u8], w: u32, h: u32, gray: bool, quality: u8) -> Result<Vec<u8>> {
    let color = if gray {
        image::ExtendedColorType::L8
    } else {
        image::ExtendedColorType::Rgb8
    };
    let mut buf: Vec<u8> = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .write_image(data, w, h, color)
        .context("JPEG 编码失败")?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    fn sample(w: u32, h: u32) -> Vec<u8> {
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = Rgb([(x % 256) as u8, (y % 256) as u8, 120]);
        }
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn long_edge_is_scaled_down_with_aspect_kept() {
        let bytes = sample(4000, 3000);
        let out = normalize(
            &bytes,
            &ImageOptions {
                long_edge: 2048,
                grayscale: true,
                passthrough: false,
            },
        )
        .unwrap();
        let img = image::load_from_memory(out.data()).unwrap();
        assert_eq!((img.width(), img.height()), (2048, 1536));
        // 灰度输出必须是单通道
        assert!(matches!(img, DynamicImage::ImageLuma8(_)));
    }

    #[test]
    fn grayscale_off_keeps_three_channels() {
        let bytes = sample(3000, 2000);
        let out = normalize(
            &bytes,
            &ImageOptions {
                long_edge: 1600,
                grayscale: false,
                passthrough: false,
            },
        )
        .unwrap();
        let img = image::load_from_memory(out.data()).unwrap();
        assert_eq!(img.width(), 1600);
        assert!(matches!(img, DynamicImage::ImageRgb8(_)));
    }

    #[test]
    fn small_gray_image_is_passed_through_untouched() {
        // 已经是灰度、尺寸达标、体积只有几 KB → 一个字节都不该改
        let mut img = image::GrayImage::new(600, 400);
        for px in img.pixels_mut() {
            *px = image::Luma([250]);
        }
        let mut bytes = Vec::new();
        DynamicImage::ImageLuma8(img)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();

        let out = normalize(&bytes, &ImageOptions::default()).unwrap();
        assert!(out.is_passthrough());
        assert_eq!(out.data(), bytes.as_slice());
    }

    #[test]
    fn force_passthrough_skips_everything() {
        let bytes = sample(4000, 3000); // 又大又是彩色，本来一定会被压
        let out = normalize(
            &bytes,
            &ImageOptions {
                long_edge: 2048,
                grayscale: true,
                passthrough: true,
            },
        )
        .unwrap();
        assert!(out.is_passthrough());
        assert_eq!(out.data(), bytes.as_slice());
    }

    #[test]
    fn grayscale_request_recompresses_even_small_color_image() {
        let bytes = sample(600, 400);
        let out = normalize(
            &bytes,
            &ImageOptions {
                long_edge: 2048,
                grayscale: true,
                passthrough: false,
            },
        )
        .unwrap();
        // 彩色小图要求转黑白 → 必须重编码，不能偷懒直传
        assert!(!out.is_passthrough());
        let img = image::load_from_memory(out.data()).unwrap();
        assert!(matches!(img, DynamicImage::ImageLuma8(_)));
    }

    /// 合成一张「答题卡」：白底 + 表格线 + 密集笔迹，用来量化瘦身效果。
    /// 断言只锁"至少省一半"，具体数字会随内容浮动，不适合写死。
    #[test]
    fn default_quality_saves_more_than_half() {
        let (w, h) = (1240u32, 1754u32); // 150dpi 的 A4，等价于"原图不大"的情况
        let mut gray = vec![238u8; (w * h) as usize];
        for y in (100..1650usize).step_by(90) {
            for x in 70..(w as usize - 70) {
                gray[y * w as usize + x] = 35;
            }
        }
        for x in (70..(w as usize - 70)).step_by(120) {
            for y in 100..1650usize {
                gray[y * w as usize + x] = 35;
            }
        }
        let mut seed: u32 = 99;
        for _ in 0..800 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let cx = 110 + (seed % (w - 300)) as usize;
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let cy = 130 + (seed % (h - 300)) as usize;
            for k in 0..(6 + seed % 14) as usize {
                let x = cx + k * 2;
                let y = cy + k % 4;
                if x < w as usize && y < h as usize {
                    gray[y * w as usize + x] = 45;
                }
            }
        }

        // 旧做法：原样三通道 JPEG q88
        let rgb: Vec<u8> = gray.iter().flat_map(|&v| [v, v, v]).collect();
        let before = encode_jpeg_at(&rgb, w, h, false, 88).unwrap().len();

        // 新默认档：灰度 + 长边 2048（不放大）+ q82
        let mut png = Vec::new();
        DynamicImage::ImageLuma8(image::GrayImage::from_raw(w, h, gray).unwrap())
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let after = normalize(&png, &ImageOptions::default()).unwrap();
        let after_len = after.data().len();

        assert!(
            after_len * 2 < before,
            "应有 >50% 的体积收益：{} → {}",
            before,
            after_len
        );
    }

    #[test]
    fn long_edge_is_clamped() {
        let opts = ImageOptions {
            long_edge: 100,
            grayscale: true,
            passthrough: false,
        };
        assert_eq!(opts.long_edge(), MIN_LONG_EDGE);
        let opts = ImageOptions {
            long_edge: 99999,
            grayscale: true,
            passthrough: false,
        };
        assert_eq!(opts.long_edge(), MAX_LONG_EDGE);
    }

    #[test]
    fn describe_reads_like_ui_copy() {
        assert_eq!(ImageOptions::default().describe(), "长边 2048 · 黑白");
        assert_eq!(
            ImageOptions {
                long_edge: 2048,
                grayscale: false,
                passthrough: false
            }
            .describe(),
            "长边 2048 · 彩色"
        );
        assert_eq!(
            ImageOptions {
                long_edge: 2048,
                grayscale: true,
                passthrough: true
            }
            .describe(),
            "原图直传"
        );
    }
}
