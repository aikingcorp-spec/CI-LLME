import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import { SHIPPED_BOT_AVATAR_SHAPE_KEYS } from "@rakazo/core";
import {
  BOT_AVATAR_COLORS,
  BotAvatar,
  BotShapePreview,
  DEFAULT_BOT_AVATAR_COLOR,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  defaultBotAvatarValue,
  defaultVnbotAvatarValue,
  parseBotAvatar,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  VNBOT_SHAPES,
  VnbotAvatar,
} from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web/components/ui/button";
import { Check, Pencil, Upload, X } from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { useRef, useState } from "react";

/**
 * Shape and colour choices for VNBot and Classic. Classic also offers organic bodies
 * before a bot has an id; otherwise Default restores the bot's own organic body.
 *
 * With `onAvatarSetChange` (a bot still being created) switching tabs commits the new
 * set with its default look. Without it, switching tabs only changes which grid is
 * shown; the saved look changes when a shape is picked, and `onChange` then receives
 * the set being viewed.
 */
export function BotLookPicker({
  value,
  identity,
  organicIdentities,
  avatarSet = "organic",
  onAvatarSetChange,
  onChange,
}: {
  value: string;
  identity?: string;
  organicIdentities?: readonly string[];
  avatarSet?: BotAvatarSet;
  onAvatarSetChange?: (set: BotAvatarSet, value: string) => void;
  onChange: (value: string, identity?: string, avatarSet?: BotAvatarSet) => void;
}) {
  const selectedSet = avatarSet === "vnbot" ? "vnbot" : "organic";
  const [browsedSet, setBrowsedSet] = useState<BotAvatarSet>();
  const viewSet = onAvatarSetChange ? selectedSet : (browsedSet ?? selectedSet);
  const showingSaved = viewSet === selectedSet;
  const shapeNames = {
    non: t`Nón`,
    chung: t`Bánh chưng`,
    aodai: t`Áo dài`,
    ran: t`Khăn rằn`,
    sen: t`Sen`,
  };
  const classicShapeNames = [
    t`hex`,
    t`wedge`,
    t`squircle`,
    t`tablet`,
    t`pebble`,
    t`blob`,
    t`teardrop`,
    t`cloud`,
  ];
  const parsed = parseBotAvatar(value);
  const currentColor = parsed.color || DEFAULT_BOT_AVATAR_COLOR;
  const isDefaultLook = showingSaved && !parsed.isImage && parsed.shapeIndex === undefined;

  function selectShape(next: string, nextIdentity?: string) {
    onChange(next, nextIdentity, showingSaved ? undefined : viewSet);
  }

  function selectColor(color: string) {
    onChange(parsed.shapeIndex === undefined ? color : `${color}::shape_${parsed.shapeIndex}`);
  }

  return (
    <div className="space-y-4">
      <Tabs
        value={viewSet}
        onValueChange={(next) => {
          const set = next === "vnbot" ? "vnbot" : "organic";
          if (!onAvatarSetChange) {
            setBrowsedSet(set);
            return;
          }
          onAvatarSetChange(
            set,
            set === "vnbot" ? defaultVnbotAvatarValue(value) : defaultBotAvatarValue(value),
          );
        }}
      >
        <TabsList className="w-full" aria-label={t`Icon set`}>
          <TabsTrigger value="vnbot" className="flex-1">
            <Trans>VNBot</Trans>
          </TabsTrigger>
          <TabsTrigger value="organic" className="flex-1">
            <Trans>Classic</Trans>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {viewSet === "vnbot" ? (
        <div className="grid grid-cols-5 place-items-center gap-2">
          {VNBOT_SHAPES.map((shape, index) => (
            <button
              key={shape}
              type="button"
              aria-label={shapeNames[shape]}
              data-testid={`vnbot-shape-${shape}`}
              aria-pressed={showingSaved && !parsed.isImage && parsed.shapeIndex === index}
              onClick={() => selectShape(`${currentColor}::shape_${index}`)}
              className="flex size-11 items-center justify-center rounded-xl hover:bg-accent aria-pressed:ring-2 aria-pressed:ring-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <VnbotAvatar shape={shape} body={currentColor} size={40} />
            </button>
          ))}
        </div>
      ) : (
        <div>
          {organicIdentities ? null : (
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                <Trans>Shape</Trans>
              </div>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="avatar-studio-default"
                aria-pressed={isDefaultLook}
                onClick={() => {
                  const next = defaultBotAvatarValue(value);
                  if (next !== value || !showingSaved) selectShape(next);
                }}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  isDefaultLook
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Trans>Default</Trans>
              </Button>
            </div>
          )}
          <div
            className={`grid place-items-center gap-2 ${organicIdentities ? "grid-cols-4 sm:grid-cols-8 sm:gap-1" : "grid-cols-4"}`}
          >
            {organicIdentities?.map((organicIdentity, index) => (
              <BotShapePreview
                key={organicIdentity}
                identity={organicIdentity}
                label={t`Shape ${index + 1}`}
                color={currentColor}
                selected={isDefaultLook && identity === organicIdentity}
                onClick={() => selectShape(currentColor, organicIdentity)}
              />
            ))}
            {SHIPPED_BOT_AVATAR_SHAPE_KEYS.map((key, shapeIndex) => (
              <BotShapePreview
                key={key}
                shapeIndex={shapeIndex}
                label={classicShapeNames[shapeIndex]}
                color={currentColor}
                selected={showingSaved && !parsed.isImage && parsed.shapeIndex === shapeIndex}
                onClick={() => selectShape(`${currentColor}::shape_${shapeIndex}`)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border pt-2">
        {organicIdentities ? null : (
          <div className="mb-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            <Trans>Color</Trans>
          </div>
        )}
        <div className="grid grid-cols-5 place-items-center gap-1 md:grid-cols-6 md:gap-2">
          {BOT_AVATAR_COLORS.map((color) => {
            const selected = currentColor.toLowerCase() === color.toLowerCase() && !parsed.isImage;
            return (
              <button
                key={color}
                type="button"
                onClick={() => selectColor(color)}
                aria-label={t`Color ${color}`}
                aria-pressed={selected}
                className={`size-6 max-md:size-11 rounded-full border transition-transform hover:scale-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "scale-105 border-transparent ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                    : "border-border"
                }`}
                style={{ backgroundColor: color }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export interface AvatarStudioPopoverProps {
  value: string;
  identity?: string;
  status?: string;
  avatarSet?: BotAvatarSet;
  size?: number;
  onChange: (value: string, avatarSet?: BotAvatarSet) => void;
  disabled?: boolean;
}

export function AvatarStudioPopover({
  value,
  identity,
  status,
  avatarSet = "organic",
  size = 72,
  onChange,
  disabled = false,
}: AvatarStudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"bot" | "upload">("bot");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function restoreDefaultAvatar() {
    const next = defaultBotAvatarValue(value);
    if (next !== value) onChange(next);
  }

  function processImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const targetSize = 256;
        canvas.width = targetSize;
        canvas.height = targetSize;
        if (!ctx) return;

        ctx.beginPath();
        ctx.arc(targetSize / 2, targetSize / 2, targetSize / 2, 0, Math.PI * 2);
        ctx.clip();

        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, targetSize, targetSize);

        onChange(canvas.toDataURL("image/webp", 0.9));
        setOpen(false);
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) processImageFile(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLButtonElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item?.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        processImageFile(file);
        break;
      }
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="group relative cursor-pointer rounded-2xl outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t`Customize bot avatar`}
        data-testid="avatar-studio-trigger"
      >
        <BotAvatar
          color={value}
          identity={identity}
          size={size}
          status={status}
          avatarSet={avatarSet === "rakazo" ? "organic" : avatarSet}
        />
        <div className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border-2 border-background bg-secondary text-foreground shadow-md transition-transform group-hover:scale-110">
          <Pencil size={12} strokeWidth={2.2} />
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[360px] max-w-full gap-4 rounded-3xl p-5 sm:max-w-[360px]"
          data-testid="avatar-studio"
        >
          <DialogHeader className="flex-row items-center justify-between space-y-0">
            <DialogTitle className="text-[14px] font-semibold tracking-tight">
              <Trans>Avatar Studio</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Choose a bot shape, color, or upload an image</Trans>
            </DialogDescription>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full text-muted-foreground"
              aria-label={t`Close`}
            >
              <X size={16} />
            </Button>
          </DialogHeader>

          <div className="flex flex-col items-center justify-center py-2">
            <BotAvatar
              color={value}
              identity={identity}
              size={78}
              status={status}
              avatarSet={avatarSet === "rakazo" ? "organic" : avatarSet}
            />
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(next) => setActiveTab(next as "bot" | "upload")}
            className="gap-4"
          >
            <div className="flex items-center justify-between border-b border-border pb-1">
              <TabsList className="rounded-full">
                <TabsTrigger value="bot" className="rounded-full px-3 text-xs">
                  <Trans>Bot</Trans>
                </TabsTrigger>
                <TabsTrigger value="upload" className="rounded-full px-3 text-xs">
                  <Trans>Upload</Trans>
                </TabsTrigger>
              </TabsList>

              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={restoreDefaultAvatar}
                className="text-xs text-muted-foreground"
              >
                <Trans>Reset</Trans>
              </Button>
            </div>

            <TabsContent value="bot" className="pt-1" data-testid="avatar-studio-bot-tab">
              <BotLookPicker
                value={value}
                identity={identity}
                avatarSet={avatarSet}
                onChange={(next, _identity, set) => onChange(next, set)}
              />
            </TabsContent>
            <TabsContent value="upload">
              <button
                type="button"
                aria-label={t`Image upload area`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onPaste={handlePaste}
                onClick={() => fileInputRef.current?.click()}
                className={`flex w-full flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/10"
                    : "border-border bg-muted hover:border-foreground/30"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) processImageFile(file);
                  }}
                />
                <div className="mb-2 grid size-10 place-items-center rounded-full bg-secondary text-muted-foreground">
                  <Upload size={18} strokeWidth={1.8} />
                </div>
                <p className="text-[12.5px] font-medium text-muted-foreground">
                  <Trans>Drag, drop, or paste an image</Trans>
                </p>
                <span className="mt-3 rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-foreground">
                  <Trans>Choose file</Trans>
                </span>
              </button>
            </TabsContent>
          </Tabs>

          <DialogFooter className="border-border sm:justify-end">
            <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)}>
              <Check size={14} />
              <Trans>Done</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
