import { useId, useState } from 'react';
import { Check, ChevronDown, ImagePlus } from 'lucide-react';
import { CHARACTER_AVATARS, getAvatarImageId } from '../shared/avatars';
import { Avatar, avatarIcons } from './components';
import { AvatarGenerator } from './AvatarGenerator';
import { useApp } from './context';

const colors = [
  { value: '#829479', nameJa: 'グリーン', nameEn: 'Green' },
  { value: '#7e94aa', nameJa: 'ブルー', nameEn: 'Blue' },
  { value: '#b79b7d', nameJa: 'サンド', nameEn: 'Sand' },
  { value: '#a38dba', nameJa: 'パープル', nameEn: 'Purple' },
  { value: '#c28883', nameJa: 'ローズ', nameEn: 'Rose' },
  { value: '#7daba4', nameJa: 'ミント', nameEn: 'Mint' },
];
const symbols = ['✦', '◈', '◎', '❋', '✺', '◒', '⌘', '✧'];
const iconLabels: Record<string, [string, string]> = {
  sparkles: ['きらめき', 'Sparkles'],
  compass: ['コンパス', 'Compass'],
  bot: ['ボット', 'Bot'],
  lightbulb: ['電球', 'Lightbulb'],
  search: ['検索', 'Search'],
  wrench: ['工具', 'Wrench'],
};

export function AvatarPicker({
  name,
  color,
  value,
  onChange,
  onColorChange,
  disabled = false,
}: {
  name: string;
  color: string;
  value: string;
  onChange: (value: string) => void;
  onColorChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useApp();
  const [generatorOpen, setGeneratorOpen] = useState(Boolean(getAvatarImageId(value)));
  const [savedColor] = useState(color);
  const panelId = useId();
  const colorLabelId = useId();
  const colorHintId = useId();
  const palette = colors.some((item) => item.value === savedColor)
    ? colors
    : [{ value: savedColor, nameJa: '保存済みの色', nameEn: 'Saved color' }, ...colors];
  return (
    <section className="avatar-picker" aria-label={t('アバター', 'Avatar')}>
      <div className="profile-customization">
        <Avatar bot={{ name, color, avatar: value }} size="large" />
        <div className="avatar-picker-options">
          <div className="character-options" aria-label={t('キャラクター', 'Characters')}>
            {CHARACTER_AVATARS.map((character) => (
              <button
                type="button"
                key={character.value}
                className={value === character.value ? 'selected' : ''}
                disabled={disabled}
                aria-pressed={value === character.value}
                aria-label={`${t('アバター', 'Avatar')} ${t(character.nameJa, character.nameEn)}`}
                onClick={() => onChange(character.value)}
              >
                <Avatar bot={{ name: character.nameEn, color, avatar: character.value }} />
                <span>{t(character.nameJa, character.nameEn)}</span>
              </button>
            ))}
          </div>
          <div className="avatar-picker-tools">
            <div className="avatar-color-picker">
              <span id={colorLabelId}>{t('アクセントカラー', 'Accent color')}</span>
              <div
                className="color-options"
                role="group"
                aria-labelledby={colorLabelId}
                aria-describedby={colorHintId}
              >
                {palette.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    aria-label={`${t('アクセントカラー', 'Accent color')} ${t(item.nameJa, item.nameEn)}`}
                    title={`${t(item.nameJa, item.nameEn)} (${item.value})`}
                    aria-pressed={color === item.value}
                    disabled={disabled}
                    className={color === item.value ? 'selected' : ''}
                    style={{ backgroundColor: item.value }}
                    onClick={() => onColorChange(item.value)}
                  >
                    {color === item.value && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                  </button>
                ))}
              </div>
              <small id={colorHintId}>
                {t(
                  '画像の枠と記号の色に反映されます。',
                  'Used for image frames and symbol colors.',
                )}
              </small>
            </div>
            <button
              type="button"
              className="text-button avatar-generator-toggle"
              aria-expanded={generatorOpen}
              aria-controls={panelId}
              onClick={() => setGeneratorOpen((open) => !open)}
            >
              <ImagePlus size={15} />
              {t('画像を生成', 'Generate image')}
              <ChevronDown size={14} className={generatorOpen ? 'expanded' : ''} />
            </button>
          </div>
          <details className="avatar-symbol-picker">
            <summary>{t('記号を使う', 'Use a symbol')}</summary>
            <div className="avatar-options">
              {Object.entries(avatarIcons).map(([key, Icon]) => (
                <button
                  type="button"
                  key={key}
                  disabled={disabled}
                  className={value.toLowerCase() === key ? 'selected' : ''}
                  onClick={() => onChange(key)}
                  aria-pressed={value.toLowerCase() === key}
                  aria-label={`${t('アバター', 'Avatar')} ${t(...iconLabels[key])}`}
                >
                  <Icon size={17} strokeWidth={1.7} />
                </button>
              ))}
              {symbols.map((symbol) => (
                <button
                  type="button"
                  key={symbol}
                  disabled={disabled}
                  className={value === symbol ? 'selected' : ''}
                  onClick={() => onChange(symbol)}
                  aria-pressed={value === symbol}
                  aria-label={`${t('アバター', 'Avatar')} ${symbol}`}
                >
                  {symbol}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
      {generatorOpen && (
        <div id={panelId}>
          <AvatarGenerator
            name={name}
            color={color}
            value={value}
            onChange={onChange}
            disabled={disabled}
          />
        </div>
      )}
    </section>
  );
}
