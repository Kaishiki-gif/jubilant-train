from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 843
img = Image.new("RGB", (W, H), (20, 20, 28))
draw = ImageDraw.Draw(img)

font_path = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
title_font = ImageFont.truetype(font_path, 100)
sub_font = ImageFont.truetype(font_path, 46)

GAP = 6
LEFT = (0, 0, W // 2 - GAP, H)
RIGHT = (W // 2 + GAP, 0, W, H)

draw.rectangle(LEFT, fill=(35, 33, 48))
draw.rectangle(RIGHT, fill=(30, 42, 50))


def center_text(d, text, font, cx, y, fill):
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    x = cx - w / 2
    d.text((x, y), text, font=font, fill=fill)


left_cx = W // 4
right_cx = 3 * W // 4

center_text(draw, "お題を", title_font, left_cx, 260, (255, 214, 10))
center_text(draw, "受け取る", title_font, left_cx, 380, (255, 214, 10))
center_text(draw, "タップで韻トレスタート", sub_font, left_cx, 540, (220, 220, 220))

center_text(draw, "韻リストを", title_font, right_cx, 260, (120, 210, 255))
center_text(draw, "見る", title_font, right_cx, 380, (120, 210, 255))
center_text(draw, "自分の記録をチェック", sub_font, right_cx, 540, (220, 220, 220))

img.save("/sessions/eager-beautiful-davinci/mnt/outputs/webhook-server/richmenu.png")
print("saved", img.size)
