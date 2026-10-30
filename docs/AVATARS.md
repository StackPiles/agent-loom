# Character avatars

Choose a bundled character in **Bots → Profile**, or configure **Settings → Image generation** and generate one from an editable description. Preview the result, choose it for the profile draft, and save to apply it. Recent results survive closing the editor and restarting Loom. Generation directly calls your configured image model without a chat-model request.

One avatar job runs at a time. Network Deny prevents generation; inference sharing follows image settings. Cancelling or restarting never automatically resubmits a request. Keep `generated-images` with the app database when backing up. See [models](MODELS.md) and [API](API.md) for protocol and limits.

## Bundled artwork

All four portraits were made for this project with ChatGPT's built-in image-generation tool on 2026-10-31, without reference images or existing characters, and are included under the repository's MIT license. Each is a 384 × 384 WebP; the combined assets are 52,448 bytes. ImageMagick resized and encoded the original artwork for lightweight distribution, keeping its composition. The built-ins work offline.

| Character | Asset                                      | Appearance                               |
| --------- | ------------------------------------------ | ---------------------------------------- |
| Aster     | [aster.webp](../public/avatars/aster.webp) | Ivory robot, sage scarf and star antenna |
| Nova      | [nova.webp](../public/avatars/nova.webp)   | Amber fox-like explorer                  |
| Orbit     | [orbit.webp](../public/avatars/orbit.webp) | Dusty-blue robot with a round antenna    |
| Moss      | [moss.webp](../public/avatars/moss.webp)   | Green forest robot with leaf-shaped ears |

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
