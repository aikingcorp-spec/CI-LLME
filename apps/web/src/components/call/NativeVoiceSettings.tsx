import { Trans, useLingui } from "@lingui/react/macro";
import { Field, FieldLabel, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

export function NativeVoiceSettings() {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const status = useQuery(queries.voice.realtime.status.queryOptions());
  const credentials = useQuery(queries.models.credentials.queryOptions());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const choices =
    credentials.data?.filter(
      (credential) => credential.provider === "openai-codex" && credential.authKind === "oauth",
    ) ?? [];
  async function configure(credentialId: string | null, voiceId: string) {
    setPending(true);
    setError(null);
    try {
      await rpc.voice.realtime.configure({ credentialId, voiceId });
      await Promise.all([
        status.refetch(),
        queryClient.invalidateQueries({ queryKey: queries.me.queryKey() }),
      ]);
    } catch (error) {
      setError(errorText(error, t`Could not save voice settings`));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mb-6 space-y-3" data-testid="native-voice-settings">
      <Field>
        <FieldLabel htmlFor={`${ids}-account`}>
          <Trans>ChatGPT voice calls</Trans>
        </FieldLabel>
        <NativeSelect
          id={`${ids}-account`}
          value={status.data?.credentialId ?? ""}
          disabled={pending || !status.data}
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
      {!choices.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Connect ChatGPT in Models to use its voice.</Trans>
        </p>
      ) : null}
      {status.data?.enabled ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${ids}-voice`}>
              <Trans>Voice</Trans>
            </FieldLabel>
            <NativeSelect
              id={`${ids}-voice`}
              value={status.data.voiceId}
              disabled={pending}
              onChange={(event) => void configure(status.data!.credentialId, event.target.value)}
            >
              {status.data.voices.map((voice) => (
                <NativeSelectOption key={voice} value={voice}>
                  {voice}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Uses your ChatGPT account. Voice availability and limits follow your plan.
            </Trans>
          </p>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
