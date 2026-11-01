import { AlertDialog } from '@base-ui/react/alert-dialog';
import { NumberField } from '@base-ui/react/number-field';
import type { ComponentProps, ReactNode } from 'react';
import { ApiFailure } from '../lib/api.ts';
import { MinusIcon, PlusIcon } from './icons.tsx';

type ButtonProps = ComponentProps<'button'> & { tone?: 'primary' | 'danger' | 'dangerSolid' | 'quiet'; size?: 'small'; icon?: boolean };

const toneClass = { primary: 'btn-primary', danger: 'btn-danger', dangerSolid: 'btn-danger-solid', quiet: 'btn-quiet' } as const;

export function Button({ tone, size, icon, className, type = 'button', ...props }: ButtonProps) {
    const classes = ['btn', tone && toneClass[tone], size === 'small' && 'btn-small', icon && 'icon-btn', className];
    return <button type={type} className={classes.filter(Boolean).join(' ')} {...props} />;
}

export function Badge({ tone, children, plain }: { tone?: 'good' | 'warn' | 'bad'; children: ReactNode; plain?: boolean }) {
    return <span className={['badge', tone && `badge-${tone}`, plain && 'badge-plain'].filter(Boolean).join(' ')}>{children}</span>;
}

/** Spend against a limit. The bar is decoration for the numbers beside it, which say the same. */
export function Meter({ value, max }: { value: number; max: number }) {
    const ratio = max > 0 ? Math.min(value / max, 1) : value > 0 ? 1 : 0;
    return (
        <div className="progress" aria-hidden="true" data-over={value > max || undefined}>
            <span className="progress-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
    );
}

export function Skeleton({ width = '100%', height }: { width?: number | string; height?: number }) {
    return <span className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
    return (
        <div className="state">
            <h2>{title}</h2>
            {children ? <p>{children}</p> : null}
            {action}
        </div>
    );
}

export function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
    return (
        <div className="state" role="alert">
            <h2>Couldn’t load this</h2>
            <p>{messageOf(error)}</p>
            <Button onClick={retry}>Try again</Button>
        </div>
    );
}

export const messageOf = (error: unknown) => (error instanceof ApiFailure ? error.message : 'Something went wrong. Try again.');

/** Money in dollars, edited with a stepper; empty is `null`. */
export function MoneyField({
    value,
    onChange,
    label,
    step = 1,
    min = 0,
    max = 100000,
    prefix,
    suffix,
}: {
    value: number | null;
    onChange: (value: number | null) => void;
    label: string;
    step?: number;
    min?: number;
    max?: number;
    prefix?: string;
    suffix?: string;
}) {
    return (
        <NumberField.Root
            value={value}
            onValueChange={onChange}
            min={min}
            max={max}
            step={step}
            smallStep={step}
            largeStep={step * 10}
            className="field"
        >
            <NumberField.Group className="number">
                <NumberField.Decrement className="number-step" aria-label={`Decrease ${label}`}>
                    <MinusIcon />
                </NumberField.Decrement>
                {prefix ? (
                    <span className="number-affix" aria-hidden="true">
                        {prefix}
                    </span>
                ) : null}
                <NumberField.Input className="number-input" aria-label={label} />
                {suffix ? (
                    <span className="number-affix" aria-hidden="true">
                        {suffix}
                    </span>
                ) : null}
                <NumberField.Increment className="number-step" aria-label={`Increase ${label}`}>
                    <PlusIcon />
                </NumberField.Increment>
            </NumberField.Group>
        </NumberField.Root>
    );
}

interface ConfirmProps {
    title: string;
    description: ReactNode;
    confirm: string;
    tone?: 'primary' | 'dangerSolid';
    onConfirm: () => void;
}

function ConfirmPopup({ title, description, confirm, tone = 'dangerSolid', onConfirm }: ConfirmProps) {
    return (
        <AlertDialog.Portal>
            <AlertDialog.Backdrop className="backdrop" />
            <AlertDialog.Popup className="dialog">
                <AlertDialog.Title>{title}</AlertDialog.Title>
                <AlertDialog.Description>{description}</AlertDialog.Description>
                <div className="dialog-actions">
                    <AlertDialog.Close render={<Button />}>Cancel</AlertDialog.Close>
                    <AlertDialog.Close render={<Button tone={tone} onClick={onConfirm} />}>{confirm}</AlertDialog.Close>
                </div>
            </AlertDialog.Popup>
        </AlertDialog.Portal>
    );
}

/** A confirmation before something with consequences, opened by its trigger button (`children`). */
export function Confirm({ children, ...props }: ConfirmProps & { children: React.ReactElement<Record<string, unknown>> }) {
    return (
        <AlertDialog.Root>
            <AlertDialog.Trigger render={children} />
            <ConfirmPopup {...props} />
        </AlertDialog.Root>
    );
}

/** The same, opened by the caller (a switch has no button to hold the trigger). */
export function ConfirmDialog({ open, onOpenChange, ...props }: ConfirmProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
    return (
        <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
            <ConfirmPopup {...props} />
        </AlertDialog.Root>
    );
}
