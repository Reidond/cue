import { Switch } from '@base-ui/react/switch';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button, ConfirmDialog, ErrorState, messageOf, MoneyField, Skeleton } from '../components/ui.tsx';
import { settingsQuery, useSaveSettings } from '../lib/queries.ts';

export const Route = createFileRoute('/settings')({
    loader: ({ context }) => {
        void context.queryClient.prefetchQuery(settingsQuery());
    },
    component: SettingsPage,
});

function SettingsPage() {
    const settings = useQuery(settingsQuery());
    const save = useSaveSettings();
    const [confirmPause, setConfirmPause] = useState(false);

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Settings</h1>
                    <p className="sub">Defaults for everyone, and a way to stop everything.</p>
                </div>
            </div>
            <section className="card" aria-label="Settings">
                {settings.isPending ? (
                    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 28, minHeight: 240 }}>
                        <Skeleton width="40%" />
                        <Skeleton width="30%" />
                        <Skeleton width="50%" />
                    </div>
                ) : settings.error && !settings.data ? (
                    <ErrorState error={settings.error} retry={() => void settings.refetch()} />
                ) : settings.data ? (
                    <>
                        <NumberSetting
                            key={`limit:${settings.data.defaultMonthlyLimitUsd}`}
                            title="Default monthly limit"
                            description="What each person may spend per month unless you set theirs on their page."
                            saved={settings.data.defaultMonthlyLimitUsd}
                            step={5}
                            max={100000}
                            money
                            onSave={(value) => save.mutate({ defaultMonthlyLimitUsd: value })}
                            saving={save.isPending}
                        />
                        <NumberSetting
                            key={`retention:${settings.data.audioRetentionDays}`}
                            title="Keep recordings for"
                            description="Days a call’s audio stays in storage once its notes are ready. The notes themselves stay."
                            saved={settings.data.audioRetentionDays}
                            step={1}
                            min={1}
                            max={3650}
                            unit="days"
                            onSave={(value) => save.mutate({ audioRetentionDays: Math.round(value) })}
                            saving={save.isPending}
                        />
                        <div className="setting">
                            <div className="setting-text">
                                <strong id="pause-label">Pause the plan</strong>
                                <span id="pause-hint">
                                    While paused, Cue answers every request with “paused” and the app asks people to try again later.
                                    Nothing is deleted, and this admin keeps working.
                                </span>
                            </div>
                            <div className="setting-control">
                                <span className="muted" aria-hidden="true" style={{ minWidth: 48, textAlign: 'right' }}>
                                    {settings.data.planPaused ? 'Paused' : 'Running'}
                                </span>
                                <Switch.Root
                                    className="switch"
                                    checked={settings.data.planPaused}
                                    onCheckedChange={(checked) => (checked ? setConfirmPause(true) : save.mutate({ planPaused: false }))}
                                    aria-labelledby="pause-label"
                                    aria-describedby="pause-hint"
                                >
                                    <Switch.Thumb className="switch-thumb" />
                                </Switch.Root>
                            </div>
                        </div>
                    </>
                ) : null}
            </section>
            {save.error ? (
                <div className="banner" role="alert">
                    {messageOf(save.error)}
                </div>
            ) : null}
            <ConfirmDialog
                open={confirmPause}
                onOpenChange={setConfirmPause}
                title="Pause Cue for everyone?"
                description="Everyone using Cue is told to try again later until you resume the plan. Calls already in progress are cut off at their next request."
                confirm="Pause the plan"
                onConfirm={() => save.mutate({ planPaused: true })}
            />
        </div>
    );
}

// Remounted when the saved value changes (the key), so the draft starts from what is saved.
function NumberSetting({
    title,
    description,
    saved,
    step,
    min = 0,
    max,
    money,
    unit,
    onSave,
    saving,
}: {
    title: string;
    description: string;
    saved: number;
    step: number;
    min?: number;
    max: number;
    money?: boolean;
    unit?: string;
    onSave: (value: number) => void;
    saving: boolean;
}) {
    const [draft, setDraft] = useState<number | null>(saved);
    const dirty = draft !== saved;
    return (
        <form
            className="setting"
            onSubmit={(event) => {
                event.preventDefault();
                if (draft !== null && dirty) onSave(draft);
            }}
        >
            <div className="setting-text">
                <strong>{title}</strong>
                <span>{description}</span>
            </div>
            <div className="setting-control">
                <MoneyField
                    label={title}
                    value={draft}
                    onChange={setDraft}
                    step={step}
                    min={min}
                    max={max}
                    prefix={money ? '$' : undefined}
                    suffix={unit}
                />
                <Button type="submit" tone="primary" disabled={!dirty || draft === null || saving}>
                    Save
                </Button>
            </div>
        </form>
    );
}
