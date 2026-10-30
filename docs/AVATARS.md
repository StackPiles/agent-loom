# Character avatars

Choose a bundled character in **Bots → Profile**, or configure **Settings → Image generation** and generate one from an editable description. Preview the result, choose it for the profile draft, and save to apply it. Recent results survive closing the editor and restarting Loom. Generation directly calls your configured image model without a chat-model request.

One avatar job runs at a time. Network Deny prevents generation; inference sharing follows image settings. Cancelling or restarting never automatically resubmits a request. Keep `generated-images` with the app database when backing up. See [models](MODELS.md) and [API](API.md) for protocol and limits.

## Accent color

**Accent color** controls the visible frame and inset around an image avatar. The selection previews immediately in the editor; saving the profile applies it throughout chat, bot cards and member lists. The original character artwork keeps its colors. Icons and initials continue to use the same selected color. Existing custom colors are preserved.

## Bundled artwork

All eight portraits were made for this project with ChatGPT's built-in image-generation tool on 2026-10-31, without reference images or existing characters, and are included under the repository's MIT license. Each is a 384 × 384 WebP; the combined assets are 101,512 bytes. ImageMagick resized and encoded the original artwork for lightweight distribution, keeping its composition. The built-ins work offline.

| Character | Asset                                      | Appearance                               |
| --------- | ------------------------------------------ | ---------------------------------------- |
| Aster     | [aster.webp](../public/avatars/aster.webp) | Ivory robot, sage scarf and star antenna |
| Nova      | [nova.webp](../public/avatars/nova.webp)   | Amber fox-like explorer                  |
| Orbit     | [orbit.webp](../public/avatars/orbit.webp) | Dusty-blue robot with a round antenna    |
| Moss      | [moss.webp](../public/avatars/moss.webp)   | Green forest robot with leaf-shaped ears |
| Luna      | [luna.webp](../public/avatars/luna.webp)   | Lilac cat robot                          |
| Pip       | [pip.webp](../public/avatars/pip.webp)     | Cream rabbit with a peach scarf          |
| Sage      | [sage.webp](../public/avatars/sage.webp)   | Teal owl robot                           |
| Bram      | [bram.webp](../public/avatars/bram.webp)   | Cocoa bear with a honey collar           |

Only the original Aster/Nova defaults upgrade once. Customized avatars and deleted bots are preserved. Legacy symbols remain available. Image failures fall back to the bot's initial within the same avatar box.

## Exact generation prompts

These prompts created the bundled artwork. Runtime avatar generation sends the owner's editable description to their configured image server.

### Aster

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels.
Primary request: a thoughtful, friendly original robot character with a rounded cream ceramic head, warm dark oval eyes, a tiny sage green sprout-like star antenna, and a sage green scarf.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, mature tasteful product illustration rather than a flat UI symbol.
Composition: one centered head-and-shoulders portrait, symmetrical face turned only slightly, character fills approximately 78% of square, entire head and ears inside frame with margin, no separate frame or circular badge.
Scene/backdrop: plain very pale warm ivory studio background, subtle soft shadow.
Color palette: sage green and warm ivory, matching a quiet cream-and-sage application UI.
Lighting/mood: soft diffuse studio light, calm helpful expression.
Constraints: exactly one original character, no text, no letters, no numbers, no logo, no watermark, no extra objects, no scenery, no gradients with vivid saturated colors. Make the face large and distinctly recognizable at tiny icon size. Output a square image.
```

### Nova

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels.
Primary request: a curious, friendly original fox-like robot explorer character with small pointed ears, warm dark oval eyes, rounded cream face panels, and a muted amber collar.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, mature tasteful product illustration rather than a flat UI symbol.
Composition: one centered head-and-shoulders portrait, symmetrical face turned only slightly, character fills approximately 78% of square, entire head and ears inside frame with margin, no separate frame or circular badge.
Scene/backdrop: plain very pale warm ivory studio background, subtle soft shadow.
Color palette: muted amber, warm cream and soft terracotta, matching a quiet cream-and-sage application UI.
Lighting/mood: soft diffuse studio light, calm helpful expression.
Constraints: exactly one original character, no text, no letters, no numbers, no logo, no watermark, no extra objects, no scenery, no gradients with vivid saturated colors. Make the face large and distinctly recognizable at tiny icon size. Output a square image.
```

### Orbit

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels.
Primary request: a friendly original small round robot character with a matte blue shell, a soft cream face, kind dark oval eyes, and a simple small circular antenna.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, mature tasteful product illustration rather than a flat UI symbol.
Composition: one centered head-and-shoulders portrait, symmetrical face turned only slightly, character fills approximately 78% of square, entire head and ears inside frame with margin, no separate frame or circular badge.
Scene/backdrop: plain very pale warm ivory studio background, subtle soft shadow.
Color palette: dusty blue, cream and soft slate, matching a quiet cream-and-sage application UI.
Lighting/mood: soft diffuse studio light, calm helpful expression.
Constraints: exactly one original character, no text, no letters, no numbers, no logo, no watermark, no extra objects, no scenery, no gradients with vivid saturated colors. Make the face large and distinctly recognizable at tiny icon size. Output a square image.
```

### Moss

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels.
Primary request: a calm friendly original forest robot character with a rounded sage green shell, a pale cream face, warm dark oval eyes and two tiny rounded leaf-shaped ears.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, mature tasteful product illustration rather than a flat UI symbol.
Composition: one centered head-and-shoulders portrait, symmetrical face turned only slightly, character fills approximately 78% of square, entire head and ears inside frame with margin, no separate frame or circular badge.
Scene/backdrop: plain very pale warm ivory studio background, subtle soft shadow.
Color palette: moss green, pale cream and muted teal, matching a quiet cream-and-sage application UI.
Lighting/mood: soft diffuse studio light, calm helpful expression.
Constraints: exactly one original character, no text, no letters, no numbers, no logo, no watermark, no extra objects, no scenery, no gradients with vivid saturated colors. Make the face large and distinctly recognizable at tiny icon size. Output a square image.
```

### Luna

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels. This joins an existing family of softly rounded cream and sage robot portraits.
Primary request: a friendly original cat-like robot character with softly pointed ears, a pale cream face, kind large dark oval eyes and a muted lilac shell, calm helpful expression.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, tasteful product illustration with the same quiet quality as a cream ceramic robot with a sage scarf. Clear simple silhouette, no busy detail.
Composition/framing: exactly one centered head-and-shoulders portrait, face nearly frontal with a subtle natural tilt, character fills about 78% of square, entire head and ears within the square with comfortable margin, eyes and facial features large enough to read at tiny avatar sizes. No outer circle, badge or frame.
Scene/backdrop: plain very pale warm ivory studio background with a subtle soft shadow.
Color palette: muted lilac, pearl cream and soft lavender, restrained saturation compatible with a warm ivory and sage green application.
Lighting/mood: soft diffuse studio light, calm friendly personality.
Constraints: one original character only; no text, letters, numbers, logos, watermark, scenery or extra objects. No resemblance to a named existing franchise character. Output a square image.
```

### Pip

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels. This joins an existing family of softly rounded cream and sage robot portraits.
Primary request: a friendly original rabbit-like robot character with short upright rounded ears fully inside the frame, a pale cream face, kind large dark oval eyes, and a muted peach neck scarf, gentle curious expression.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, tasteful product illustration with the same quiet quality as a cream ceramic robot with a sage scarf. Clear simple silhouette, no busy detail.
Composition/framing: exactly one centered head-and-shoulders portrait, face nearly frontal with a subtle natural tilt, character fills about 78% of square, entire head and ears within the square with comfortable margin, eyes and facial features large enough to read at tiny avatar sizes. No outer circle, badge or frame.
Scene/backdrop: plain very pale warm ivory studio background with a subtle soft shadow.
Color palette: warm ivory, soft peach and dusty coral, restrained saturation compatible with a warm ivory and sage green application.
Lighting/mood: soft diffuse studio light, calm friendly personality.
Constraints: one original character only; no text, letters, numbers, logos, watermark, scenery or extra objects. No resemblance to a named existing franchise character. Output a square image.
```

### Sage

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels. This joins an existing family of softly rounded cream and sage robot portraits.
Primary request: a friendly original owl-like robot character with a rounded head, small rounded ear tufts, large kind dark oval eyes within cream circular face panels, a tiny soft amber beak and a muted teal shell, thoughtful expression.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, tasteful product illustration with the same quiet quality as a cream ceramic robot with a sage scarf. Clear simple silhouette, no busy detail.
Composition/framing: exactly one centered head-and-shoulders portrait, face nearly frontal with a subtle natural tilt, character fills about 78% of square, entire head and ears within the square with comfortable margin, eyes and facial features large enough to read at tiny avatar sizes. No outer circle, badge or frame.
Scene/backdrop: plain very pale warm ivory studio background with a subtle soft shadow.
Color palette: muted teal, pale cream and soft amber, restrained saturation compatible with a warm ivory and sage green application.
Lighting/mood: soft diffuse studio light, calm friendly personality.
Constraints: one original character only; no text, letters, numbers, logos, watermark, scenery or extra objects. No resemblance to a named existing franchise character. Output a square image.
```

### Bram

```text
Use case: stylized-concept
Asset type: a single square character avatar for the Agent Loom local AI chat application, readable at 32 to 80 pixels. This joins an existing family of softly rounded cream and sage robot portraits.
Primary request: a friendly original bear-like robot character with small round ears, a warm cream muzzle, kind large dark oval eyes and a cocoa-brown shell with a muted honey collar, reassuring relaxed expression.
Style/medium: polished soft 3D character illustration, rounded simple forms, matte clay and ceramic feel, gentle expressive face, tasteful product illustration with the same quiet quality as a cream ceramic robot with a sage scarf. Clear simple silhouette, no busy detail.
Composition/framing: exactly one centered head-and-shoulders portrait, face nearly frontal with a subtle natural tilt, character fills about 78% of square, entire head and ears within the square with comfortable margin, eyes and facial features large enough to read at tiny avatar sizes. No outer circle, badge or frame.
Scene/backdrop: plain very pale warm ivory studio background with a subtle soft shadow.
Color palette: soft cocoa brown, warm cream and muted honey, restrained saturation compatible with a warm ivory and sage green application.
Lighting/mood: soft diffuse studio light, calm friendly personality.
Constraints: one original character only; no text, letters, numbers, logos, watermark, scenery or extra objects. No resemblance to a named existing franchise character. Output a square image.
```
