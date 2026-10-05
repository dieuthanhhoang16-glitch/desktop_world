#!/bin/bash
# world/creature/convert-girl.sh
# 「girl」桌宠素材制备：~/Downloads/girl 的 8 个 MP4(720² 白底 H.264)
#   → themes/girl/assets/*.apng（240² 透明底循环动画）+ 静态兜底 PNG。
#
# 依赖 ffmpeg（系统没有就先装：brew install ffmpeg，或 FFMPEG=/path/to/ffmpeg）。
# 用法：bash world/creature/convert-girl.sh
set -euo pipefail

SRC="${GIRL_SRC:-$HOME/Downloads/girl}"
OUT="$(cd "$(dirname "$0")/../.." && pwd)/themes/girl/assets"
FFMPEG="${FFMPEG:-ffmpeg}"

command -v "$FFMPEG" >/dev/null 2>&1 || {
  echo "❌ 找不到 ffmpeg。先安装：brew install ffmpeg"; exit 1;
}
[ -d "$SRC" ] || { echo "❌ 源目录不存在：$SRC"; exit 1; }
mkdir -p "$OUT"

# 制作约定（锚定 Calico 实测，docs/v0.6-research.md 第三节）：
#   帧数：常驻 ~32（16fps × 2s）；单文件目标 ≤800KB
#   取中段 2s 避开首尾运动斜坡；白底 → 透明（colorkey 适度收边）
#   真彩 APNG 体积爆炸（3MB+/个），二遍调色板化 256 色压到预算内
#   （sierra2_4a 抖动在全帧抖动里闪烁最轻；alpha 二值化去半透明流苏）
FPS=16
SIZE=200
KEY="colorkey=0xFFFFFF:0.14:0.18"
PALETTE="palettegen=reserve_transparent=on"
APPLY="paletteuse=dither=sierra2_4a:alpha_threshold=128"

convert() { # <源文件> <起始秒> <时长秒> <输出名>
  local src="$1" ss="$2" dur="$3" name="$4"
  local pal; pal="$(mktemp -t girlpal).png"
  "$FFMPEG" -hide_banner -loglevel error -y \
    -ss "$ss" -t "$dur" -i "$SRC/$src" \
    -vf "fps=$FPS,scale=$SIZE:$SIZE:flags=lanczos,$KEY,$PALETTE" \
    -update 1 "$pal"
  "$FFMPEG" -hide_banner -loglevel error -y \
    -ss "$ss" -t "$dur" -i "$SRC/$src" -i "$pal" \
    -filter_complex "[0:v]fps=$FPS,scale=$SIZE:$SIZE:flags=lanczos,$KEY[x];[x][1:v]$APPLY" \
    -f apng -plays 0 "$OUT/$name"
  rm -f "$pal"
  echo "  ✓ $name"
}

echo "== 转码 8 段视频 → APNG =="
convert "idle.mp4"                        2   2    girl-idle.apng
convert "敲键盘.mp4"                      2   2    girl-working-typing.apng
convert "搬砖.mp4"                        2   2    girl-working-building.apng
convert "思考.mp4"                        2   2    girl-thinking.apng
convert "三颗星星.mp4"                    3   1.6  girl-juggling.apng
convert "conducting 拿小指挥棒.mp4"      1   2    girl-working-conducting.apng
convert "attention 开心挥手 + 星星闪光.mp4" 0.8 2.4 girl-attention.apng
convert "notification 举信封 + 感叹号.mp4" 1.5 2   girl-notification.apng
convert "sleeping.mp4"                    1   2    girl-sleeping.apng

echo "== 静态兜底（girl.png → 去白底缩小，同样调色板化）=="
pal="$(mktemp -t girlpal).png"
"$FFMPEG" -hide_banner -loglevel error -y \
  -i "$SRC/girl.png" -vf "scale=$SIZE:$SIZE:flags=lanczos,$KEY,$PALETTE" -update 1 "$pal"
"$FFMPEG" -hide_banner -loglevel error -y \
  -i "$SRC/girl.png" -i "$pal" \
  -filter_complex "[0:v]scale=$SIZE:$SIZE:flags=lanczos,$KEY[x];[x][1:v]$APPLY" \
  -update 1 "$OUT/girl-idle-static.png"
rm -f "$pal"
echo "  ✓ girl-idle-static.png"

echo "== 产物 =="
ls -la "$OUT"
echo
echo "下一步：node scripts/validate-theme.js themes/girl"
