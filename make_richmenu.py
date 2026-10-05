from PIL import Image, ImageDraw, ImageFont
import os

# リッチメニュー画像(3分割): お題を受け取る / 韻リストを見る / ラップバトル
W, H = 2500, 843
img = Image.new("RGB", (W, H), (20, 20, 28))
draw = ImageDraw.Draw(img)

font_path = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
title_font = ImageFont.truetype(font_path, 88)
sub_font = ImageFont.truetype(font_path, 40)

GAP = 6
COL = W / 3
cols = [
    ((0, 0, COL - GAP, H), (35, 33, 48)),
    ((COL + GAP, 0, 2 * COL - GAP, H), (30, 42, 50)),
    ((2 * COL + GAP, 0, W, H), (52, 30, 34)),
]
for box, fill in cols:
    draw.rectangle(box, fill=fill)


def center_text(d, text, font, cx, y, fill):
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    d.text((cx - w / 2, y), text, font=font, fill=fill)


cx = [COL / 2, COL * 1.5, COL * 2.5]

center_text(draw, "お題を", title_font, cx[0], 250, (255, 214, 10))
center_text(draw, "受け取る", title_font, cx[0], 360, (255, 214, 10))
center_text(draw, "タップで韻トレスタート", sub_font, cx[0], 520, (220, 220, 220))

center_text(draw, "韻リストを", title_font, cx[1], 250, (120, 210, 255))
center_text(draw, "見る", title_font, cx[1], 360, (120, 210, 255))
center_text(draw, "自分の記録をチェック", sub_font, cx[1], 520, (220, 220, 220))

center_text(draw, "ラップ", title_font, cx[2], 250, (255, 120, 120))
center_text(draw, "バトル", title_font, cx[2], 360, (255, 120, 120))
center_text(draw, "撮ったものと対戦", sub_font, cx[2], 520, (220, 220, 220))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "richmenu.png")
img.save(out)
print("saved", out, img.size)
