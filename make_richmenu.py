from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 843
img = Image.new("RGB", (W, H), (30, 30, 40))  # ダークな背景(ラップ/ヒップホップ感)
draw = ImageDraw.Draw(img)

font_path = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
title_font = ImageFont.truetype(font_path, 130)
sub_font = ImageFont.truetype(font_path, 58)

title = "今日のお題を受け取る"
sub = "タップして韻トレスタート"

def center_text(d, text, font, y, fill):
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    x = (W - w) / 2
    d.text((x, y), text, font=font, fill=fill)

center_text(draw, title, title_font, 300, (255, 214, 10))
center_text(draw, sub, sub_font, 500, (230, 230, 230))

img.save("/sessions/eager-beautiful-davinci/mnt/outputs/webhook-server/richmenu.png")
print("saved", img.size)
