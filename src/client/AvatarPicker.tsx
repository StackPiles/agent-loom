import { useId, useState } from 'react';
import { ChevronDown, ImagePlus } from 'lucide-react';
import { CHARACTER_AVATARS, getAvatarImageId } from '../shared/avatars';
import { Avatar, avatarIcons } from './components';
import { AvatarGenerator } from './AvatarGenerator';
import { useApp } from './context';

const colors = ['#829479', '#7e94aa', '#b79b7d', '#a38dba', '#c28883', '#7daba4'];
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
  const panelId = useId();
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
            <div className="color-options" aria-label={t('ボットの色', 'Bot color')}>
              {colors.map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-label={`${t('色', 'Color')} ${item}`}
                  aria-pressed={color === item}
                  disabled={disabled}
                  className={color === item ? 'selected' : ''}
                  style={{ backgroundColor: item }}
                  onClick={() => onColorChange(item)}
                />
              ))}
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
