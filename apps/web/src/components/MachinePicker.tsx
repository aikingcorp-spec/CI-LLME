import { Trans, useLingui } from "@lingui/react/macro";
import { isPrivateNetworkHost } from "@rakazo/contracts/network-host";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { buttonVariants } from "@rakazo/ui-web/components/ui/button-variants";
import { inputClass } from "@rakazo/ui-web/components/ui/input-variants";
import { Label } from "@rakazo/ui-web/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@rakazo/ui-web/components/ui/radio-group";
import { cn } from "@rakazo/ui-web/lib/utils";
import { useState } from "react";

const ADDRESS_ERROR_ID = "machine-address-error";
const choiceClass =
  "flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-base has-data-checked:border-primary has-data-disabled:text-muted-foreground";

/**
 * What a person types ("vps.example.com", "192.168.1.5:6130") as an http(s) origin, or null. Same
 * rules as the desktop setup: no credentials in the address, and plain http only on a private
 * network, because sign-in cookies must not cross the public internet in cleartext.
 */
export function normalizeMachineUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    let url: URL;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) url = new URL(trimmed);
    else {
      const candidate = new URL(`http://${trimmed}`);
      url = isPrivateNetworkHost(candidate.hostname) ? candidate : new URL(`https://${trimmed}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
    if (url.protocol === "http:" && !isPrivateNetworkHost(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function MachinePicker({
  onThisComputer,
  onOwnMachine,
}: {
  onThisComputer: () => void;
  onOwnMachine: (url: string) => void;
}) {
  const { t } = useLingui();
  const [choice, setChoice] = useState<"this-computer" | "own-machine">("this-computer");
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);

  function next() {
    if (choice === "this-computer") {
      onThisComputer();
      return;
    }
    const url = normalizeMachineUrl(address);
    if (url === null) setInvalid(true);
    else onOwnMachine(url);
  }

  return (
    <div className="w-full">
      <RadioGroup
        aria-label={t`Machine`}
        value={choice}
        onValueChange={(value) => {
          setChoice(value as typeof choice);
          setInvalid(false);
        }}
      >
        <Label className={choiceClass}>
          <RadioGroupItem value="this-computer" />
          <Trans>This computer</Trans>
        </Label>
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
      {choice === "own-machine" ? (
        <div className="mt-4">
          <Label htmlFor="machine-address" className="text-muted-foreground">
            <Trans>Server address</Trans>
          </Label>
          <input
            id="machine-address"
            name="machine-address"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://vnbot.example.com"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalid(false);
            }}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? ADDRESS_ERROR_ID : undefined}
            data-slot="input"
            data-size="default"
            className={cn(inputClass, "mt-2 h-12 rounded-xl px-4 text-base md:text-base")}
          />
          {invalid ? (
            <p id={ADDRESS_ERROR_ID} role="alert" className="mt-3 text-sm text-destructive">
              <Trans>Enter a valid http:// or https:// address.</Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {/* Inside the page's form, so Enter in the address field clicks this. */}
      <button
        type="submit"
        data-slot="button"
        className={cn(buttonVariants({ size: "lg" }), "mt-3 h-12 w-full rounded-xl text-base")}
        onClick={next}
      >
        <Trans>Continue</Trans>
      </button>
    </div>
  );
}
