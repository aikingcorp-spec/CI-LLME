import { Trans, useLingui } from "@lingui/react/macro";
import { Field, FieldLabel, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
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
        <NativeSelect
          id={`${ids}-account`}
          value={status.data?.credentialId ?? ""}
          disabled={disabled || pending || !status.data}
          onChange={(event) =>
            void configure(event.target.value || null, status.data?.voiceId ?? "cove")
          }
        >
          <NativeSelectOption value="">{t`Off`}</NativeSelectOption>
          {choices.map((credential) => (
            <NativeSelectOption key={credential.id} value={credential.id}>
              {credential.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {status.data?.enabled ? (
        <Field>
          <FieldLabel htmlFor={`${ids}-voice`}>
            <Trans>Voice</Trans>
          </FieldLabel>
          <NativeSelect
            id={`${ids}-voice`}
            value={status.data.voiceId}
            disabled={disabled || pending}
            onChange={(event) => void configure(status.data!.credentialId, event.target.value)}
          >
            {status.data.voices.map((voice) => (
              <NativeSelectOption key={voice} value={voice}>
                {voice}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
