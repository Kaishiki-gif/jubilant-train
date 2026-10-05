from PIL import Image, ImageDraw, ImageFont
import os

# リッチメニュー画像(2分割): お題を受け取る / ラップバトル
W, H = 2500, 843
img = Image.new("RGB", (W, H), (20, 20, 28))
draw = ImageDraw.Draw(img)

font_path = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
title_font = ImageFont.truetype(font_path, 100)
sub_font = ImageFont.truetype(font_path, 46)

GAP = 6
draw.rectangle((0, 0, W // 2 - GAP, H), fill=(35, 33, 48))
draw.rectangle((W // 2 + GAP, 0, W, H), fill=(52, 30, 34))


def center_text(d, text, font, cx, y, fill):
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    d.text((cx - w / 2, y), text, font=font, fill=fill)


left_cx = W // 4
right_cx = 3 * W // 4

center_text(draw, "お題を", title_font, left_cx, 260, (255, 214, 10))
center_text(draw, "受け取る", title_font, left_cx, 380, (255, 214, 10))
center_text(draw, "タップで韻トレスタート", sub_font, left_cx, 540, (220, 220, 220))

center_text(draw, "ラップ", title_font, right_cx, 260, (255, 120, 120))
center_text(draw, "バトル", title_font, right_cx, 380, (255, 120, 120))
center_text(draw, "撮ったものと対戦", sub_font, right_cx, 540, (220, 220, 220))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "richmenu.png")
img.save(out)
print("saved", out, img.size)
