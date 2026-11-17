import { Trans, useLingui } from "@lingui/react/macro";
import { Field, FieldLabel, OptionSelect } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

export function NativeVoiceSettings({ disabled = false }: { disabled?: boolean }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const status = useQuery(queries.voice.realtime.status.queryOptions());
  const credentials = useQuery(queries.models.credentials.queryOptions());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const choices =
    credentials.data?.filter(
      (credential) =>
        credential.supportsAccountVoice || credential.id === status.data?.credentialId,
    ) ?? [];
  async function configure(credentialId: string | null, voiceId: string) {
    setPending(true);
    setError(null);
    try {
      await rpc.voice.realtime.configure({ credentialId, voiceId });
      await status.refetch();
    } catch (error) {
      setError(errorText(error, t`Could not save voice settings`));
    } finally {
      setPending(false);
    }
  }
  const loadError = status.error ?? credentials.error;
  if (!loadError && !status.data?.enabled && !choices.length) return null;
  return (
    <div className="mb-6 space-y-3" data-testid="native-voice-settings">
      <Field>
        <FieldLabel htmlFor={`${ids}-account`}>
          <Trans>Account voice</Trans>
        </FieldLabel>
        <OptionSelect
          id={`${ids}-account`}
          value={status.data?.credentialId ?? ""}
          disabled={disabled || pending || !status.data}
          options={[
            { value: "", label: t`Off` },
            ...choices.map((credential) => ({ value: credential.id, label: credential.label })),
          ]}
          onValueChange={(next) => void configure(next || null, status.data?.voiceId ?? "cove")}
        />
      </Field>
      {status.data?.enabled ? (
        <Field>
          <FieldLabel htmlFor={`${ids}-voice`}>
            <Trans>Voice</Trans>
          </FieldLabel>
          <OptionSelect
            id={`${ids}-voice`}
            value={status.data.voiceId}
            disabled={disabled || pending}
            options={status.data.voices.map((voice) => ({ value: voice, label: voice }))}
            onValueChange={(next) => void configure(status.data!.credentialId, next)}
          />
        </Field>
      ) : null}
      {error || loadError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error ?? errorText(loadError, t`Could not load voice settings`)}
        </p>
      ) : null}
    </div>
  );
}
