/** Only bundled characters and app-managed raster images can become image avatars. */
export const CHARACTER_AVATARS = [
  { value: 'character:aster', src: '/avatars/aster.webp', nameJa: 'アスター', nameEn: 'Aster' },
  { value: 'character:nova', src: '/avatars/nova.webp', nameJa: 'ノヴァ', nameEn: 'Nova' },
  { value: 'character:orbit', src: '/avatars/orbit.webp', nameJa: 'オービット', nameEn: 'Orbit' },
  { value: 'character:moss', src: '/avatars/moss.webp', nameJa: 'モス', nameEn: 'Moss' },
  { value: 'character:luna', src: '/avatars/luna.webp', nameJa: 'ルナ', nameEn: 'Luna' },
  { value: 'character:pip', src: '/avatars/pip.webp', nameJa: 'ピップ', nameEn: 'Pip' },
  { value: 'character:sage', src: '/avatars/sage.webp', nameJa: 'セージ', nameEn: 'Sage' },
  { value: 'character:bram', src: '/avatars/bram.webp', nameJa: 'ブラム', nameEn: 'Bram' },
] as const;

export function getAvatarImageId(value: string): string | undefined {
  return /^image:img_[a-f0-9]{64}$/.test(value) ? value.slice('image:'.length) : undefined;
}

export function getAvatarImageSource(value: string): string | undefined {
  const character = CHARACTER_AVATARS.find((entry) => entry.value === value);
  if (character) return character.src;
  const imageId = getAvatarImageId(value);
  return imageId ? `/api/images/${imageId}` : undefined;
}

/** Preserve existing short symbols/icon names, without accepting remote URLs or markup. */
export function isValidAvatar(value: string): boolean {
  if (getAvatarImageSource(value)) return true;
  return value.length <= 40 && !/[\u0000-\u001f\u007f<>:/\\]/.test(value);
}
