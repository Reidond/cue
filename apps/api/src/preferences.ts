import type { AccountSettings, AccountSettingsPatch } from '@cue/contract';

// The settings that are the person's, not a device's (the `preference` table, migrations/0011_account_settings.sql): what answers and notes call
// them, Auto, questions from the room, summaries, keeping audio. Each is null until the account has it: the first app to sign in sends its own
// once, and until then a call or a note goes by what its request says (the apps from before the account kept them send them every time).

interface Row {
    speaker_name: string | null;
    auto_answer: number | null;
    mic_questions: number | null;
    summarize: number | null;
    keep_audio: number | null;
}

export const NO_SETTINGS: AccountSettings = { speakerName: null, autoAnswer: null, micQuestions: null, summarize: null, keepAudio: null };

const flag = (value: number | null) => (value === null ? null : value !== 0);
const bit = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);

export async function settingsOf(db: D1Database, userId: string): Promise<AccountSettings> {
    const row = await db
        .prepare('SELECT speaker_name, auto_answer, mic_questions, summarize, keep_audio FROM preference WHERE user_id = ?')
        .bind(userId)
        .first<Row>();
    if (!row) return NO_SETTINGS;
    return {
        speakerName: row.speaker_name,
        autoAnswer: flag(row.auto_answer),
        micQuestions: flag(row.mic_questions),
        summarize: flag(row.summarize),
        keepAudio: flag(row.keep_audio),
    };
}

/** Changes the settings the patch names; the others stay as they are. */
export async function saveSettings(db: D1Database, userId: string, patch: AccountSettingsPatch): Promise<AccountSettings> {
    await db
        .prepare(
            `INSERT INTO preference (user_id, speaker_name, auto_answer, mic_questions, summarize, keep_audio, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET
                speaker_name = COALESCE(excluded.speaker_name, preference.speaker_name),
                auto_answer = COALESCE(excluded.auto_answer, preference.auto_answer),
                mic_questions = COALESCE(excluded.mic_questions, preference.mic_questions),
                summarize = COALESCE(excluded.summarize, preference.summarize),
                keep_audio = COALESCE(excluded.keep_audio, preference.keep_audio),
                updated_at = excluded.updated_at`,
        )
        .bind(
            userId,
            patch.speakerName ?? null,
            bit(patch.autoAnswer),
            bit(patch.micQuestions),
            bit(patch.summarize),
            bit(patch.keepAudio),
            Date.now(),
        )
        .run();
    return settingsOf(db, userId);
}
