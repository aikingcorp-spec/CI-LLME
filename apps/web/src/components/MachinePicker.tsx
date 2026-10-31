import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { Label } from "@rakazo/ui-web/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@rakazo/ui-web/components/ui/radio-group";

const choiceClass =
  "flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-base has-data-checked:border-primary has-data-disabled:opacity-50 has-data-disabled:text-muted-foreground";

export function MachinePicker() {
  const { t } = useLingui();
  return (
    <div className="w-full">
      <RadioGroup aria-label={t`Machine`} value="own-machine">
        <Label className={choiceClass}>
          <RadioGroupItem value="own-machine" />
          <Trans>Your own machine (VPS, Mac mini, any server)</Trans>
        </Label>
        <Label className={choiceClass}>
          <RadioGroupItem value="cloud" disabled />
          <Trans>VNBot Cloud</Trans>
          <Badge variant="secondary" className="ms-auto">
            <Trans>Coming soon</Trans>
          </Badge>
        </Label>
      </RadioGroup>
      <p role="status" className="mt-4 text-sm text-muted-foreground">
        <Trans>Connect by pairing — coming soon</Trans>
      </p>
    </div>
  );
}
