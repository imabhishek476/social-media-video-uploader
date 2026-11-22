# Jumbo Surfer: YouTube channel kit

Apply everything in **YouTube Studio → Customization** (about 5 minutes).

## 1. Name and handle (Customization → Basic info)

| Field | Value |
|---|---|
| **Name** | `Jumbo Surfer \| Gaming Highlights` |
| **Handle** | `@JumboSurfer` (matches Instagram @jumbo_surfer; fallback `@JumboSurferGaming`) |

Why: "Jumbo Surfer" matches your Instagram, so followers can find you on both. "Gaming Highlights" tells new viewers and YouTube search what the channel is. You can drop it once the channel is known.

## 2. Description (Customization → Basic info → Description)

```
🏄 Jumbo Surfer: surfing the best moments from gaming livestreams, every day.

Clutch plays, funniest fails, rage moments and insane reactions from the biggest streamers, cut into bite-sized Shorts so you never miss the highlights.

🔥 What you'll find here
• Funny moments & fails
• Rage & reactions
• Clutch plays & insane wins
• GTA 6, GTA RP, Valorant, BGMI, Minecraft, Fortnite & more
• Indian & international streamer highlights

📅 New Shorts DAILY. Subscribe and turn on 🔔 so you catch every highlight.

All clips are credited to the original streamer in each video's description. Streamers: want your highlights featured (or removed)? Email us.

#jumbosurfer #gaming #gamingclips #streamhighlights #funnymoments #shorts #gta6
```

## 3. Links (Customization → Basic info → Links)

1. **Instagram**: `https://www.instagram.com/jumbo_surfer/`. Shown on the banner.
2. **Subscribe**: `https://www.youtube.com/@JumboSurfer?sub_confirmation=1`. Use your final handle; the link opens a subscribe prompt.
3. Add Discord, X or another link later if you create them.

Also add a **business email** under *Contact info*. Streamers and brands use it, and it helps with permission requests.

## 4. Images (Customization → Branding)

| Item | File | Notes |
|---|---|---|
| Picture | `branding/avatar.png` (800×800) | Neon "JS" monogram over a wave; still readable at small sizes |
| Banner | `branding/banner.png` (2560×1440) | Key text sits inside the 1546×423 safe area, so it shows on all devices |
| Video watermark | `branding/avatar.png` | Display: entire video. Adds a subscribe button on desktop |

## 5. Keywords (Settings → Channel → Basic info → Keywords)

```
jumbo surfer, gaming highlights, stream highlights, gaming clips, funny gaming moments, gaming shorts, streamer moments, rage moments, clutch plays, gta 6, gta 6 funny moments, gta rp, valorant clips, bgmi highlights, minecraft funny, fortnite clips, mythpat, ishowspeed, indian streamers, live stream highlights, best moments
```

## 6. Settings that help reach

- **Settings → Channel → Basic info → Country**: India. **Language**: English (or Hindi if most clips are in Hindi).
- **Settings → Upload defaults**: Category *Gaming*, plus the description footer below.
- **Customization → Layout**:
  - Featured section: **Shorts**.
  - Channel trailer: your best Short.
- **Playlists**: create "GTA 6 Funny Moments", "Rage & Reactions", "Clutch Plays", and one per streamer. Add Shorts to them. Playlists rank in search too.
- **Pin a comment** on each Short asking a question ("Who's next? 👇"). Comments boost the Shorts feed.

### Upload-default description footer

```
🏄 Jumbo Surfer: daily gaming stream highlights
🔔 Subscribe for new Shorts every day
#jumbosurfer #gaming #shorts #streamhighlights
```

## 7. Applying changes later

Edit `branding/src/avatar.html` or `branding/src/banner.html`, then re-render from the project root:

```bash
cd branding && google-chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=2560,1440 --screenshot="$PWD/banner.png" "file://$PWD/src/banner.html"
```
