// SPDX-License-Identifier: Apache-2.0

import { useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronsUpDown,
  ImageUp,
  Shapes,
  Smile,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import {
  EmojiPicker,
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
} from "frimousse";
import {
  APPEARANCE_COLORS,
  EMOJI_ICON_PREFIX,
  LUCIDE_ICON_PREFIX,
  derivedColor,
  isAppearanceColor,
  parseIcon,
  type AppearanceColor,
  type AppearanceIcon,
  type IconForm,
} from "@appstrate/core/appearance";
import { cn } from "@appstrate/ui/cn";
import { IDENTITY_COLOR_CLASSES } from "@appstrate/ui/identity-colors";
import { isLucideName } from "@appstrate/ui/lucide-names";
import { Button } from "@appstrate/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@appstrate/ui/components/command";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { Label } from "@appstrate/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { I18N_FALLBACK_LANGUAGE, I18N_SUPPORTED_LANGUAGES } from "../i18n-config";
import { AUTO_COLOR, colorChange } from "../lib/appearance-change";
import {
  ICON_SOURCE_TYPES,
  encodeIconImage,
  iconImageErrorCode,
  type IconImageError,
} from "../lib/icon-image";

/** A stored identity: `null` icon = none, `null` colour = derived from the entity id. */
export interface AppearanceValue {
  icon: string | null;
  color: string | null;
}

/** What the picker emits: only the field that changed. */
interface AppearanceChange {
  icon?: string | null;
  color?: AppearanceColor | null;
}

const FORM_LABEL_KEYS: Record<IconForm, string> = {
  lucide: "appearance.form.lucide",
  emoji: "appearance.form.emoji",
  image: "appearance.form.image",
};

const FORM_ICONS: Record<IconForm, LucideIcon> = {
  lucide: Shapes,
  emoji: Smile,
  image: ImageUp,
};

const COLOR_NAME_KEYS: Record<AppearanceColor, string> = {
  neutral: "appearance.colorName.neutral",
  blue: "appearance.colorName.blue",
  emerald: "appearance.colorName.emerald",
  violet: "appearance.colorName.violet",
  amber: "appearance.colorName.amber",
  rose: "appearance.colorName.rose",
  cyan: "appearance.colorName.cyan",
  pink: "appearance.colorName.pink",
  orange: "appearance.colorName.orange",
};

const ICON_ERROR_KEYS: Record<IconImageError, string> = {
  icon_file_type: "appearance.error.icon_file_type",
  icon_file_size: "appearance.error.icon_file_size",
  icon_processing: "appearance.error.icon_processing",
};

const FEATURED_ICONS: IconName[] = [
  "bot",
  "sparkles",
  "brain",
  "workflow",
  "receipt",
  "mail",
  "calendar-clock",
  "database",
  "file-text",
  "inbox",
  "newspaper",
  "chart-bar",
];
const ICON_RESULT_LIMIT = 80;
const EMOJI_COLUMNS = 9;

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** The form an icon was written in, when the editor can write that form. */
function formOf(icon: AppearanceIcon | null): IconForm | null {
  if (icon?.kind === "lucide") return "lucide";
  if (icon?.kind === "emoji") return "emoji";
  if (icon?.kind === "url" && icon.src.startsWith("data:image/")) return "image";
  return null;
}

/** The emoji dataset's language: the UI's, when Emojibase ships it. */
function emojiLocale(language: string | undefined): string {
  return (
    I18N_SUPPORTED_LANGUAGES.find((supported) => supported === language) ?? I18N_FALLBACK_LANGUAGE
  );
}

/** Ring of a swatch when its radio — visually hidden, the preceding sibling — is checked or focused. */
const SWATCH_RING =
  "peer-data-[state=checked]:ring-ring peer-data-[state=checked]:ring-2 peer-data-[state=checked]:ring-offset-2 peer-focus-visible:ring-ring peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50";

/** A colour choice: a dot of the hue on its tile tint, or `children` in its place. */
function Swatch({ color, children }: { color: AppearanceColor; children?: ReactNode }) {
  return (
    <span
      className={cn(
        "border-border flex size-8 items-center justify-center rounded-full border transition-shadow",
        IDENTITY_COLOR_CLASSES[color],
        SWATCH_RING,
      )}
    >
      {children ?? <span className="size-3 rounded-full bg-current" />}
    </span>
  );
}

/**
 * The identity editor of an agent, a space or an organization: a preview tile,
 * the icon in the forms `allow` lists, and the colour (one of the palette, or
 * « Automatique » — derived from `seed`, the entity id). `onChange` receives
 * only the field that changed. `fallbackIcon` is the preview's, as the
 * entity's own tiles draw it (`IdentityTile`).
 */
export function AppearancePicker({
  value,
  onChange,
  allow,
  seed,
  label,
  fallbackIcon,
  disabled = false,
}: {
  value: AppearanceValue;
  onChange: (next: AppearanceChange) => void;
  allow: readonly IconForm[];
  seed: string;
  label: string;
  fallbackIcon?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const iconLabelId = useId();
  const colorLabelId = useId();
  const parsed = parseIcon(value.icon);
  const [picked, setPicked] = useState<IconForm | null>(null);
  const storedForm = formOf(parsed);
  const form =
    allow.find((candidate) => candidate === picked) ??
    allow.find((candidate) => candidate === storedForm) ??
    allow[0];

  const formField = (candidate: IconForm) => {
    switch (candidate) {
      case "lucide":
        return (
          <LucideIconField
            labelId={iconLabelId}
            picked={parsed?.kind === "lucide" && isLucideName(parsed.name) ? parsed.name : null}
            disabled={disabled}
            onPick={(name) => onChange({ icon: `${LUCIDE_ICON_PREFIX}${name}` })}
          />
        );
      case "emoji":
        return (
          <EmojiField
            picked={parsed?.kind === "emoji" ? parsed.emoji : null}
            disabled={disabled}
            onPick={(emoji) => onChange({ icon: `${EMOJI_ICON_PREFIX}${emoji}` })}
          />
        );
      case "image":
        return <ImageField disabled={disabled} onPick={(icon) => onChange({ icon })} />;
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="border-border bg-muted/20 flex items-center gap-3 rounded-lg border p-3">
        <IdentityTile
          icon={value.icon}
          color={value.color}
          seed={seed}
          label={label}
          fallbackIcon={fallbackIcon}
          className="size-11"
        />
        <p className="min-w-0 truncate text-sm font-medium">{label}</p>
      </div>

      {form && (
        <div role="group" aria-labelledby={iconLabelId} className="flex flex-col gap-2">
          <div className="flex min-h-8 items-center justify-between gap-2">
            <Label id={iconLabelId} className="mb-0">
              {t("appearance.icon")}
            </Label>
            {value.icon !== null && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => onChange({ icon: null })}
              >
                <X />
                {t("appearance.remove")}
              </Button>
            )}
          </div>
          {allow.length > 1 ? (
            <Tabs
              value={form}
              onValueChange={(next) => {
                const nextForm = allow.find((candidate) => candidate === next);
                if (nextForm) setPicked(nextForm);
              }}
            >
              <TabsList
                aria-label={t("appearance.formLabel")}
                className="h-auto w-fit flex-wrap justify-start max-sm:grid max-sm:w-full max-sm:auto-cols-fr max-sm:grid-flow-col"
              >
                {allow.map((candidate) => {
                  const FormIcon = FORM_ICONS[candidate];
                  return (
                    <TabsTrigger
                      key={candidate}
                      value={candidate}
                      disabled={disabled}
                      className="gap-1.5"
                    >
                      <FormIcon className="size-4" />
                      {t(FORM_LABEL_KEYS[candidate])}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {allow.map((candidate) => (
                <TabsContent key={candidate} value={candidate}>
                  {formField(candidate)}
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            formField(form)
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label id={colorLabelId} className="mb-0">
          {t("appearance.color")}
        </Label>
        <RadioGroup
          aria-labelledby={colorLabelId}
          disabled={disabled}
          value={isAppearanceColor(value.color) ? value.color : AUTO_COLOR}
          onValueChange={(next) => onChange(colorChange(next))}
          className="flex flex-wrap items-center gap-2"
        >
          <Label className="flex cursor-pointer items-center gap-2 pr-1">
            <RadioGroupItem value={AUTO_COLOR} className="peer sr-only" />
            <Swatch color={derivedColor(seed)}>
              <Sparkles className="size-3.5" />
            </Swatch>
            <span className="text-sm font-normal">{t("appearance.colorAuto")}</span>
          </Label>
          {APPEARANCE_COLORS.map((color) => (
            <Label key={color} className="cursor-pointer" title={t(COLOR_NAME_KEYS[color])}>
              <RadioGroupItem value={color} className="peer sr-only" />
              <Swatch color={color} />
              <span className="sr-only">{t(COLOR_NAME_KEYS[color])}</span>
            </Label>
          ))}
        </RadioGroup>
        {parsed?.kind === "url" && (
          <p className="text-muted-foreground text-xs">{t("appearance.colorBehindImage")}</p>
        )}
      </div>
    </div>
  );
}

function LucideIconField({
  labelId,
  picked,
  disabled,
  onPick,
}: {
  /** The « Icône » label: a combobox takes no name from its content. */
  labelId: string;
  picked: IconName | null;
  disabled: boolean;
  onPick: (name: IconName) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const valueId = useId();
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return FEATURED_ICONS;
    return iconNames.filter((name) => name.includes(needle));
  }, [query]);
  const visible = matches.slice(0, ICON_RESULT_LIMIT);

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-labelledby={`${labelId} ${valueId}`}
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className="flex min-w-0 items-center gap-2">
              {picked && <DynamicIcon name={picked} className="size-4 shrink-0" />}
              <span id={valueId} className={cn("truncate", !picked && "text-muted-foreground")}>
                {picked ? iconLabel(picked) : t("appearance.iconPick")}
              </span>
            </span>
            <ChevronsUpDown className="text-muted-foreground shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[32rem] max-w-[calc(100vw-2rem)] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("appearance.iconSearch")}
            />
            <CommandList>
              <CommandEmpty>{t("appearance.iconEmpty")}</CommandEmpty>
              <CommandGroup
                heading={
                  query
                    ? t("appearance.iconResults", { count: matches.length })
                    : t("appearance.iconFeatured")
                }
              >
                <div className="grid grid-cols-2 gap-1 p-1 sm:grid-cols-3">
                  {visible.map((name) => (
                    <CommandItem
                      key={name}
                      value={name}
                      onSelect={() => {
                        onPick(name);
                        setOpen(false);
                      }}
                      className="min-w-0 gap-2"
                    >
                      <DynamicIcon name={name} className="size-4 shrink-0" />
                      <span className="truncate text-xs">{iconLabel(name)}</span>
                      <Check
                        className={cn(
                          "ml-auto shrink-0",
                          picked === name ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
                </div>
              </CommandGroup>
              {matches.length > ICON_RESULT_LIMIT && (
                <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs">
                  {t("appearance.iconRefine", {
                    visible: ICON_RESULT_LIMIT,
                    count: matches.length,
                  })}
                </p>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-muted-foreground text-xs">
        {t("appearance.iconLibrary", { count: iconNames.length })}
      </p>
    </div>
  );
}

function EmojiField({
  picked,
  disabled,
  onPick,
}: {
  picked: string | null;
  disabled: boolean;
  onPick: (emoji: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          {/* The emoji is read, not hidden: it is the field's current value, as the
              Lucide trigger names its icon. */}
          <span className="flex min-w-0 items-center gap-2">
            {picked && <span className="text-base leading-none">{picked}</span>}
            <span className={cn("truncate", !picked && "text-muted-foreground")}>
              {t(picked ? "appearance.emojiChange" : "appearance.emojiPick")}
            </span>
          </span>
          <ChevronsUpDown className="text-muted-foreground shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-fit p-0">
        <EmojiPanel
          onPick={(emoji) => {
            onPick(emoji);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Frimousse, styled with the app's tokens. Mounted only while the popover is
 * open: that is when it reads the dataset the build serves under `emojibase/`
 * (`vite.config.ts`). Frimousse caches it in localStorage and revalidates it
 * through its ETag, which the server answers with a 304 while it is unchanged.
 */
function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const { t, i18n } = useTranslation();
  return (
    <EmojiPicker.Root
      locale={emojiLocale(i18n.resolvedLanguage)}
      emojibaseUrl={`${import.meta.env.BASE_URL}emojibase`}
      columns={EMOJI_COLUMNS}
      onEmojiSelect={({ emoji }) => onPick(emoji)}
      className="bg-popover text-popover-foreground isolate flex h-80 w-fit flex-col"
    >
      <div className="border-border border-b p-2">
        <EmojiPicker.Search
          placeholder={t("appearance.emojiSearch")}
          className="placeholder:text-muted-foreground bg-muted/40 h-8 w-full rounded-md px-2.5 text-sm outline-hidden"
        />
      </div>
      <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
        <EmojiPicker.Loading className="absolute inset-0 grid grid-cols-9 content-start gap-1 p-2">
          {Array.from({ length: EMOJI_COLUMNS * 6 }, (_, index) => (
            <Skeleton key={index} className="size-7 rounded-md" />
          ))}
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          {t("appearance.emojiEmpty")}
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="pb-1 select-none"
          components={{ CategoryHeader: EmojiCategoryHeader, Row: EmojiRow, Emoji: EmojiButton }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}

function EmojiCategoryHeader({
  category,
  className,
  ...props
}: EmojiPickerListCategoryHeaderProps) {
  return (
    <div
      {...props}
      className={cn(
        "bg-popover text-muted-foreground px-3 pt-3 pb-1.5 text-xs font-medium",
        className,
      )}
    >
      {category.label}
    </div>
  );
}

function EmojiRow({ className, ...props }: EmojiPickerListRowProps) {
  return <div {...props} className={cn("scroll-my-1 px-2", className)} />;
}

function EmojiButton({ emoji, className, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button
      {...props}
      type="button"
      className={cn(
        "data-[active]:bg-accent flex size-8 items-center justify-center rounded-md text-lg",
        className,
      )}
    >
      {emoji.emoji}
    </button>
  );
}

function ImageField({ disabled, onPick }: { disabled: boolean; onPick: (icon: string) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IconImageError | null>(null);
  const errorId = useId();

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Cleared so picking the same file again fires a change.
    event.currentTarget.value = "";
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      onPick(await encodeIconImage(file));
    } catch (failure) {
      setError(iconImageErrorCode(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept={ICON_SOURCE_TYPES}
        className="hidden"
        tabIndex={-1}
        onChange={(event) => void upload(event)}
      />
      {/* Not disabled while encoding: focus is back on it when the file dialog
          closes, and disabling it would drop that focus to the page. */}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        disabled={disabled}
        aria-busy={busy}
        aria-describedby={error ? errorId : undefined}
        onClick={() => {
          if (!busy) input.current?.click();
        }}
      >
        {busy ? <Spinner /> : <Upload />}
        {t("appearance.upload")}
      </Button>
      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {t(ICON_ERROR_KEYS[error])}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">{t("appearance.uploadHint")}</p>
      )}
    </div>
  );
}
