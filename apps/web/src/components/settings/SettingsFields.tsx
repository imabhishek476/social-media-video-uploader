import { useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { AppSettingsInput } from '@shorts/shared-types';

export type Section = keyof AppSettingsInput;
export type Draft = Record<Section, Record<string, string | number>>;

type Option = { value: string; label: string; description?: string; preview?: ReactNode };

export interface FieldDef {
  section: Section;
  key: string;
  label: string;
  /** number/text/select/color as usual; cards = big picture choices; times/days = friendly pickers. */
  kind: 'number' | 'text' | 'select' | 'color' | 'days' | 'times' | 'cards';
  options?: Option[];
  /** Select whose values are numbers (stored as numbers). */
  numeric?: boolean;
  helper?: string;
  unit?: string;
  multiline?: boolean;
  /** Width: full row, half (default) or a third. */
  width?: 'full' | 'half' | 'third';
  readOnly?: boolean;
  /** Hidden until "Show advanced settings" is clicked. */
  advanced?: boolean;
  /** Only shown when this returns true (hides settings that don't apply). */
  showIf?: (d: Draft) => boolean;
}

export interface Group {
  title: string;
  description: string;
  fields: FieldDef[];
  /** Plain-language summary or warning above the fields, from the current values. */
  note?: (d: Draft) => ReactNode;
}

const opt = (value: string | number, label: string, description?: string, preview?: ReactNode): Option => ({ value: String(value), label, description, preview });
const scheduled = (d: Draft) => d.publishing.timingMode !== 'IMMEDIATE';
const custom = (d: Draft) => d.subtitles.captionStyle === 'CUSTOM';

// ---------------------------------------------------------------------------
// Pictures for the layout and caption choices
// ---------------------------------------------------------------------------

const CAM = '#7c4dff';
const GAME = '#2e7d32';

function Phone({ children }: { children: ReactNode }) {
  return <Box sx={{ width: 46, height: 82, borderRadius: 1, border: '2px solid', borderColor: 'text.secondary', overflow: 'hidden', position: 'relative', bgcolor: GAME, flexShrink: 0 }}>{children}</Box>;
}
const Label = ({ children, sx }: { children: string; sx?: object }) => (
  <Box sx={{ position: 'absolute', color: '#fff', fontSize: 9, fontWeight: 700, textAlign: 'center', width: '100%', ...sx }}>{children}</Box>
);

const LAYOUT_PICS: Record<string, ReactNode> = {
  FACECAM_SPLIT: (
    <Phone>
      <Box sx={{ height: '45%', bgcolor: CAM, borderBottom: '2px solid #fff' }} />
      <Label sx={{ top: 12 }}>You</Label>
      <Label sx={{ top: 55 }}>Game</Label>
    </Phone>
  ),
  GAMEPLAY: (
    <Phone>
      <Box sx={{ position: 'absolute', top: 6, left: 4, width: 18, height: 14, bgcolor: CAM, border: '1px solid #22F0FF' }} />
      <Label sx={{ top: 40 }}>Game</Label>
    </Phone>
  ),
  BLUR_FIT: (
    <Phone>
      <Box sx={{ position: 'absolute', inset: 0, bgcolor: '#555' }} />
      <Box sx={{ position: 'absolute', top: 30, left: 0, right: 0, height: 22, bgcolor: GAME }} />
      <Label sx={{ top: 35 }}>Whole</Label>
    </Phone>
  ),
  CENTER_CROP: (
    <Phone>
      <Label sx={{ top: 35 }}>Middle</Label>
    </Phone>
  ),
};

function CaptionPic({ font, size, color, word, upper = true, glow }: { font: string; size: number; color: string; word: string; upper?: boolean; glow?: boolean }) {
  const t = (s: string) => (upper ? s.toUpperCase() : s);
  return (
    <Box sx={{ width: 120, height: 56, borderRadius: 1, bgcolor: '#263238', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Typography sx={{ fontFamily: font, fontWeight: 900, fontSize: size, lineHeight: 1, color: '#fff', textShadow: glow ? '0 0 6px #a0e6f0' : '2px 2px 0 #000, -1px -1px 0 #000' }}>
        {t('no')} <span style={{ color: word }}>{t('way')}</span>
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Friendly lists
// ---------------------------------------------------------------------------

const TIME_ZONES = [
  opt('Asia/Kolkata', 'India (IST)'),
  opt('UTC', 'UTC (world time)'),
  opt('Asia/Dubai', 'Dubai (GST)'),
  opt('Asia/Singapore', 'Singapore'),
  opt('Europe/London', 'London (UK)'),
  opt('America/New_York', 'New York (US East)'),
  opt('America/Los_Angeles', 'Los Angeles (US West)'),
  opt('Australia/Sydney', 'Sydney'),
];
const LANGUAGES = [opt('en', 'English'), opt('hi', 'Hindi'), opt('es', 'Spanish'), opt('pt', 'Portuguese'), opt('fr', 'French'), opt('de', 'German'), opt('ja', 'Japanese'), opt('ko', 'Korean'), opt('ar', 'Arabic')];
const every = (secs: number[]) => secs.map((s) => opt(s, s < 60 ? `Every ${s} seconds` : s === 60 ? 'Every minute' : `Every ${s / 60} minutes`));

const time12 = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
};
const listTimes = (s: string) =>
  s
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => t.padStart(5, '0'))
    .sort();
const joinList = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const ordinal = (n: number) => `${n}${n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** One sentence that says what the schedule settings will do. */
function scheduleSummary(d: Draft): string {
  const p = d.publishing;
  if (p.timingMode === 'IMMEDIATE') return 'Each Short goes public as soon as it finishes uploading.';
  const times = listTimes(String(p.slotTimes)).map(time12);
  const tz = TIME_ZONES.find((z) => z.value === p.timezone)?.label ?? String(p.timezone);
  const gap = Number(p.dayGap) || 0;
  const days =
    gap === 0 ? 'on the same day it’s scheduled (or the next day if today’s times have passed)' : gap === 1 ? 'on the day after it’s scheduled' : `on the ${ordinal(gap)} day after it’s scheduled (scheduled today → ${new Date(Date.now() + gap * 86_400_000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })})`;
  const FULL: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const skipped = String(p.skipDays).split(',').map((x) => FULL[x.trim().slice(0, 3).toLowerCase()]).filter(Boolean) as string[];
  const skip = skipped.length ? `, but never on ${joinList(skipped)}` : '';
  const perTime = ' Any number of Shorts per day, spread over these times.';
  const perStream = Number(p.maxPerSourcePerDay) > 0 ? ` At most ${p.maxPerSourcePerDay} from the same stream on one day.` : '';
  const best = p.timingMode === 'BEST_TIME' ? ' Once enough Shorts have views, the app switches to the hours that work best for your channel.' : '';
  return `Each Short goes public ${days}, at one of ${joinList(times) || '(no times set)'} ${tz} time${skip}.${perTime}${perStream}${best}`;
}

// ---------------------------------------------------------------------------
// The settings, grouped by what you're trying to do
// ---------------------------------------------------------------------------

/** Tabs; a platform tab (`connector`) shows its account connection above its settings. Add new platforms the same way. */
export const TABS: Array<{ id: string; label: string; connector?: 'youtube' | 'instagram'; groups: Group[] }> = [
  {
    id: 'publishing',
    label: 'Publishing',
    groups: [
      {
        title: 'Approval',
        description: 'What happens when a new Short is ready.',
        fields: [
          {
            section: 'publishing',
            key: 'mode',
            label: 'Before publishing',
            kind: 'cards',
            width: 'full',
            options: [opt('MANUAL_APPROVAL', 'I check each Short first', 'Shorts wait in Clip Studio until you press Approve.'), opt('AUTO_PUBLISH', 'Publish automatically', 'Every new Short is approved and scheduled without you.')],
          },
        ],
      },
      {
        title: 'Schedule',
        description: 'When approved Shorts go public. They upload early and YouTube publishes them at the chosen time.',
        note: (d) =>
          scheduled(d) && d.publishing.privacyStatus !== 'public' ? (
            <Alert severity="warning">The schedule is paused because new YouTube Shorts aren’t public. In the YouTube tab, set “Who can see new Shorts” to Everyone.</Alert>
          ) : (
            <Alert severity="info" icon={false}>
              {scheduleSummary(d)}
            </Alert>
          ),
        fields: [
          {
            section: 'publishing',
            key: 'timingMode',
            label: 'Publish time',
            kind: 'cards',
            width: 'full',
            options: [
              opt('BEST_TIME', 'Best time', 'Learns from your views. Starts with your times below.'),
              opt('FIXED_SLOTS', 'My own times', 'Always at the times below.'),
              opt('IMMEDIATE', 'Straight away', 'As soon as each Short is uploaded.'),
            ],
          },
          { section: 'publishing', key: 'slotTimes', label: 'Best times of day', kind: 'times', width: 'full', helper: 'Shorts are spread over these times. There is no limit per time or per day.', showIf: scheduled },
          { section: 'publishing', key: 'timezone', label: 'Time zone', kind: 'select', options: TIME_ZONES },
          {
            section: 'publishing',
            key: 'dayGap',
            label: 'Publish on',
            kind: 'select',
            numeric: true,
            options: [opt(0, 'The same day (next best time)'), opt(1, 'The next day'), opt(2, '2nd day after scheduling'), opt(3, '3rd day after scheduling'), opt(5, '5th day after scheduling'), opt(7, '1 week after scheduling')],
            helper: 'Counted from the day each Short is scheduled.',
            showIf: scheduled,
          },
          { section: 'publishing', key: 'skipDays', label: 'Posting days', kind: 'days', width: 'full', showIf: scheduled },
          {
            section: 'publishing',
            key: 'maxPerSourcePerDay',
            label: 'Shorts from one stream per day',
            kind: 'select',
            numeric: true,
            options: [opt(1, 'At most 1'), opt(2, 'At most 2'), opt(3, 'At most 3'), opt(5, 'At most 5'), opt(0, 'No limit')],
            helper: 'Spreads a stream’s Shorts over several days so your feed has variety.',
            showIf: scheduled,
          },
          { section: 'publishing', key: 'windowStartHour', label: 'Only upload from (hour)', kind: 'number', unit: 'h', helper: '0 to 24 means any time', showIf: (d) => !scheduled(d) },
          { section: 'publishing', key: 'windowEndHour', label: 'Until (hour)', kind: 'number', unit: 'h', showIf: (d) => !scheduled(d) },
          { section: 'publishing', key: 'dailyUploadLimit', label: 'Most Shorts per day', kind: 'number', helper: '0 = no limit', showIf: (d) => !scheduled(d) },
          { section: 'publishing', key: 'minMinutesBetweenUploads', label: 'Wait between Shorts', kind: 'number', unit: 'min', showIf: (d) => !scheduled(d) },
        ],
      },
    ],
  },
  {
    id: 'youtube',
    label: 'YouTube',
    connector: 'youtube',
    groups: [
      {
        title: 'Uploads',
        description: 'How Shorts appear on your YouTube channel.',
        fields: [
          {
            section: 'publishing',
            key: 'privacyStatus',
            label: 'Who can see new Shorts on YouTube',
            kind: 'select',
            width: 'full',
            options: [opt('public', 'Everyone (Public)'), opt('unlisted', 'Only people with the link (Unlisted)'), opt('private', 'Only me (Private)')],
            helper: 'Choose Everyone to use the schedule in the Publishing tab.',
          },
        ],
      },
      {
        title: 'Comments',
        description: 'Comments help YouTube show a Short to more people.',
        fields: [
          {
            section: 'publishing',
            key: 'firstComment',
            label: 'Ask viewers a question',
            kind: 'cards',
            width: 'full',
            options: [opt('ON', 'On (recommended)', 'When a Short goes public, your channel posts a question about it as the first comment (pin it in YouTube Studio for best results).'), opt('OFF', 'Off')],
          },
        ],
      },
      {
        title: 'Title & description',
        description: 'Added to every new YouTube Short.',
        fields: [
          { section: 'publishing', key: 'descriptionFooter', label: 'Text at the end of every description', kind: 'text', multiline: true, width: 'full', helper: 'e.g. your channel name and a “Subscribe” line.' },
          { section: 'publishing', key: 'channelHashtags', label: 'Your hashtags', kind: 'text', helper: 'Separate with commas, no # needed' },
          {
            section: 'publishing',
            key: 'categoryId',
            label: 'YouTube category',
            kind: 'select',
            options: [opt('20', 'Gaming'), opt('24', 'Entertainment'), opt('23', 'Comedy'), opt('22', 'People & Blogs'), opt('17', 'Sports')],
          },
        ],
      },
    ],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    connector: 'instagram',
    groups: [
      {
        title: 'Posting',
        description: 'Which Shorts are also posted as Instagram Reels.',
        fields: [
          {
            section: 'publishing',
            key: 'instagramMode',
            label: 'Post to Instagram',
            kind: 'cards',
            width: 'full',
            options: [opt('WITH_YOUTUBE', 'Every Short', 'Every approved Short is also posted as a Reel.'), opt('MANUAL', 'Only when I choose', 'Use “Post to Instagram” on a Short.')],
          },
          {
            section: 'publishing',
            key: 'instagramTiming',
            label: 'When to post the Reel',
            kind: 'cards',
            width: 'full',
            options: [
              opt('SAME_AS_YOUTUBE', 'Same time as YouTube', 'Waits for the Short’s scheduled YouTube time (the app posts it then; the server must be running).'),
              opt('IMMEDIATE', 'Straight away', 'Posts the Reel as soon as the Short is approved, even if YouTube is scheduled for later.'),
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'style',
    label: 'Short style',
    groups: [
      {
        title: 'Layout',
        description: 'How the stream fits into the tall Short.',
        fields: [
          {
            section: 'clips',
            key: 'reframingMode',
            label: 'Layout',
            kind: 'cards',
            width: 'full',
            options: [
              opt('FACECAM_SPLIT', 'Split screen', 'Streamer’s webcam on top, game below.', LAYOUT_PICS.FACECAM_SPLIT),
              opt('GAMEPLAY', 'Game + small webcam', 'Game fills the screen, webcam in a corner.', LAYOUT_PICS.GAMEPLAY),
              opt('BLUR_FIT', 'Whole picture', 'Nothing cut off; blurred edges above and below.', LAYOUT_PICS.BLUR_FIT),
              opt('CENTER_CROP', 'Middle only', 'Zooms into the middle of the stream.', LAYOUT_PICS.CENTER_CROP),
            ],
            helper: 'If no webcam is found, split screen shows the whole picture and “Game + small webcam” shows the middle.',
          },
          {
            section: 'clips',
            key: 'coldOpen',
            label: 'Start with the best moment',
            kind: 'cards',
            width: 'full',
            options: [opt('ON', 'On (recommended)', 'Each Short opens with a 2-second flash of its best moment, then plays from the start. Stops people swiping away.'), opt('OFF', 'Off', 'Plays the clip from its start.')],
          },
        ],
      },
      {
        title: 'Length',
        description: 'How long each Short is.',
        fields: [
          { section: 'clips', key: 'minDurationSeconds', label: 'Shortest', kind: 'number', unit: 'sec', width: 'third' },
          { section: 'clips', key: 'defaultDurationSeconds', label: 'Usually', kind: 'number', unit: 'sec', width: 'third' },
          { section: 'clips', key: 'maxDurationSeconds', label: 'Longest', kind: 'number', unit: 'sec', width: 'third' },
        ],
      },
      {
        title: 'Captions',
        description: 'Words on screen as the streamer speaks.',
        fields: [
          {
            section: 'subtitles',
            key: 'captionStyle',
            label: 'Caption style',
            kind: 'cards',
            width: 'full',
            options: [
              opt('STREAMER', 'Streamer', 'Glowing, spoken word in yellow.', <CaptionPic font="Poppins, sans-serif" size={18} color="#FFE14D" word="#FFE14D" glow />),
              opt('HYPE', 'Hype', 'Huge red pop, 2 words at a time.', <CaptionPic font="Anton, Impact, sans-serif" size={24} color="#FF3B3B" word="#FF3B3B" />),
              opt('BOUNCE', 'Bounce', '3 words, spoken word in cyan.', <CaptionPic font="Poppins, sans-serif" size={18} color="#22F0FF" word="#22F0FF" />),
              opt('CLEAN', 'Clean', 'Calm, normal letters.', <CaptionPic font="Poppins, sans-serif" size={16} color="#9FD4FF" word="#9FD4FF" upper={false} />),
              opt('CUSTOM', 'My own', 'Pick the font and colours.', <CaptionPic font="sans-serif" size={18} color="#FFD400" word="#FFD400" />),
            ],
          },
          { section: 'subtitles', key: 'fontFamily', label: 'Font', kind: 'text', showIf: custom },
          { section: 'subtitles', key: 'fontSize', label: 'Size', kind: 'number', unit: 'px', showIf: custom },
          { section: 'subtitles', key: 'primaryColor', label: 'Text colour', kind: 'color', showIf: custom },
          { section: 'subtitles', key: 'highlightColor', label: 'Colour of the word being spoken', kind: 'color', showIf: custom },
          { section: 'subtitles', key: 'position', label: 'Where captions sit', kind: 'select', options: [opt('MIDDLE', 'Middle'), opt('BOTTOM', 'Bottom'), opt('TOP', 'Top')], helper: 'Split screen and game layouts place them automatically.' },
          { section: 'subtitles', key: 'language', label: 'Usual language spoken', kind: 'select', options: LANGUAGES, helper: 'You can set it per streamer too.' },
        ],
      },
      {
        title: 'Headline',
        description: 'A short, bold headline at the top of the Short (e.g. “HE DID WHAT?!”).',
        fields: [
          {
            section: 'subtitles',
            key: 'hookOverlay',
            label: 'Show the headline',
            kind: 'cards',
            width: 'full',
            options: [opt('INTRO', 'First 4 seconds'), opt('ALWAYS', 'Whole Short'), opt('OFF', 'Never')],
          },
          {
            section: 'subtitles',
            key: 'reactionSticker',
            label: 'Our reaction sticker',
            kind: 'cards',
            width: 'full',
            options: [opt('ON', 'On (recommended)', 'A short yellow comment from your channel, e.g. “He really thought that would work”. Makes the Short clearly your own edit, which YouTube’s monetization rules look for.'), opt('OFF', 'Off')],
          },
        ],
      },
    ],
  },
  {
    id: 'highlights',
    label: 'Highlights',
    groups: [
      {
        title: 'Choosing the best moments',
        description: 'Defaults for every streamer (each streamer can have their own).',
        fields: [
          { section: 'clips', key: 'maxClipsPerStream', label: 'Most Shorts from one stream', kind: 'number' },
          { section: 'clips', key: 'minHighlightScore', label: 'Quality bar (0–100)', kind: 'number', helper: 'Higher = fewer but better Shorts. 70–85 works well.' },
        ],
      },
      {
        title: 'Watching for live streams',
        description: 'How quickly the app notices streams. Checking more often uses more of your daily YouTube allowance.',
        fields: [
          { section: 'monitoring', key: 'intervalSeconds', label: 'Look for new live streams', kind: 'select', numeric: true, options: every([60, 120, 300, 600, 900, 1800]) },
          {
            section: 'monitoring',
            key: 'chatPollSeconds',
            label: 'Read live chat (finds hype moments)',
            kind: 'select',
            numeric: true,
            options: [opt(0, 'Off'), ...every([30, 60, 120, 300])],
          },
          { section: 'monitoring', key: 'sessionWatchIntervalSeconds', label: 'Check if a live stream ended', kind: 'select', numeric: true, options: every([30, 60, 120, 300]), advanced: true },
          { section: 'monitoring', key: 'endConfirmationChecks', label: 'Checks before a stream counts as ended', kind: 'number', advanced: true, helper: 'Avoids ending too early on a short break.' },
        ],
      },
    ],
  },
  {
    id: 'system',
    label: 'Storage',
    groups: [
      {
        title: 'AI spending',
        description: 'The app pauses new work when this month’s AI cost reaches the limit.',
        fields: [{ section: 'costs', key: 'monthlyBudgetUsd', label: 'Monthly limit', kind: 'number', unit: 'USD', helper: '0 = no limit' }],
      },
      {
        title: 'Free up disk space',
        description: 'Old files are deleted automatically. 0 = keep forever.',
        fields: [
          { section: 'retention', key: 'sourceAfterDoneDays', label: 'Delete a stream recording … days after its Shorts are done', kind: 'number', unit: 'days', width: 'full' },
          { section: 'retention', key: 'sourceDays', label: 'Delete any recording after', kind: 'number', unit: 'days' },
          { section: 'retention', key: 'clipDays', label: 'Delete finished Short files after', kind: 'number', unit: 'days' },
          { section: 'retention', key: 'transcriptDays', label: 'Delete transcripts after', kind: 'number', unit: 'days', advanced: true },
        ],
      },
      {
        title: 'Limits',
        description: 'Protection against very long streams.',
        fields: [
          { section: 'processing', key: 'maxSourceDurationMinutes', label: 'Longest stream to process', kind: 'number', unit: 'min' },
          { section: 'processing', key: 'maxSourceFileSizeMb', label: 'Largest file', kind: 'number', unit: 'MB', advanced: true },
          { section: 'processing', key: 'maxConcurrentJobs', label: 'Tasks at the same time', kind: 'number', advanced: true, helper: 'Higher = faster, but uses more of the computer.' },
        ],
      },
      {
        title: 'Services in use',
        description: 'For information only. A developer changes these.',
        fields: [
          {
            section: 'providers',
            key: 'transcription',
            label: 'Turning speech into text',
            kind: 'select',
            readOnly: true,
            options: [opt('local', 'On this computer (free)'), opt('openai', 'Online (Whisper / Groq)'), opt('mock', 'Test mode')],
          },
          { section: 'providers', key: 'llm', label: 'AI that picks moments and writes titles', kind: 'select', readOnly: true, options: [opt('gemini', 'Google Gemini'), opt('anthropic', 'Claude'), opt('mock', 'Test mode')] },
          {
            section: 'providers',
            key: 'videoSource',
            label: 'Getting stream recordings',
            kind: 'select',
            readOnly: true,
            width: 'full',
            options: [opt('local,ytdlp', 'Your uploads + automatic download'), opt('local', 'Only your uploads'), opt('ytdlp', 'Automatic download'), opt('mock', 'Test mode')],
          },
        ],
      },
    ],
  },
];

export const ALL_FIELDS = TABS.flatMap((t) => t.groups.flatMap((g) => g.fields));

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function DaysField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const set = new Set(value.split(',').map((d) => d.trim().slice(0, 3).toLowerCase()).filter(Boolean));
  const toggle = (d: string) => {
    const k = d.toLowerCase();
    if (set.has(k)) set.delete(k);
    else set.add(k);
    onChange(DAYS.filter((x) => set.has(x.toLowerCase())).join(', '));
  };
  return (
    <div>
      <Typography variant="body2" sx={{ mb: 0.75 }}>
        {label} <Typography component="span" variant="caption" color="text.secondary">(tap a day to turn it on or off)</Typography>
      </Typography>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
        {DAYS.map((d) => {
          const off = set.has(d.toLowerCase());
          return <Chip key={d} label={off ? `${d} · off` : d} disabled={disabled} color={off ? 'default' : 'primary'} variant={off ? 'outlined' : 'filled'} onClick={() => toggle(d)} sx={off ? { textDecoration: 'line-through' } : undefined} />;
        })}
      </Stack>
    </div>
  );
}

function TimesField({ label, helper, value, disabled, onChange }: { label: string; helper?: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [adding, setAdding] = useState('19:00');
  const times = listTimes(value);
  const save = (list: string[]) => onChange([...new Set(list)].sort().join(', '));
  return (
    <div>
      <Typography variant="body2" sx={{ mb: 0.75 }}>
        {label}
      </Typography>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
        {times.map((t) => (
          <Chip key={t} label={time12(t)} color="primary" disabled={disabled} onDelete={disabled ? undefined : () => save(times.filter((x) => x !== t))} />
        ))}
        {!times.length && (
          <Typography variant="body2" color="error">
            Add at least one time
          </Typography>
        )}
        {!disabled && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField size="small" type="time" value={adding} onChange={(e) => setAdding(e.target.value)} sx={{ width: 130 }} />
            <Button size="small" variant="outlined" disabled={!adding || times.includes(adding)} onClick={() => save([...times, adding])}>
              Add time
            </Button>
          </Stack>
        )}
      </Stack>
      {helper && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {helper}
        </Typography>
      )}
    </div>
  );
}

function CardsField({ field, value, disabled, onChange }: { field: FieldDef; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <div>
      <Typography variant="body2" sx={{ mb: 0.75 }}>
        {field.label}
      </Typography>
      <Grid container spacing={1}>
        {field.options!.map((o) => {
          const selected = o.value === value;
          return (
            <Grid key={o.value} size={{ xs: 12, sm: field.options!.length > 3 ? 6 : 12 / field.options!.length }}>
              <ButtonBase
                disabled={disabled}
                onClick={() => onChange(o.value)}
                aria-pressed={selected}
                sx={{
                  width: '100%',
                  height: '100%',
                  textAlign: 'left',
                  justifyContent: 'flex-start',
                  p: 1.25,
                  borderRadius: 1.5,
                  border: '2px solid',
                  borderColor: selected ? 'primary.main' : 'divider',
                  bgcolor: selected ? 'action.selected' : 'transparent',
                  gap: 1.5,
                }}
              >
                {o.preview}
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {o.label}
                  </Typography>
                  {o.description && (
                    <Typography variant="caption" color="text.secondary">
                      {o.description}
                    </Typography>
                  )}
                </Box>
              </ButtonBase>
            </Grid>
          );
        })}
      </Grid>
      {field.helper && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {field.helper}
        </Typography>
      )}
    </div>
  );
}

export function FieldInput({ field, draft, canEdit, onChange }: { field: FieldDef; draft: Draft; canEdit: boolean; onChange: (raw: string) => void }) {
  const raw = draft[field.section][field.key];
  const value = raw === undefined || raw === null ? '' : String(raw);
  const disabled = !canEdit || Boolean(field.readOnly);
  if (field.kind === 'days') return <DaysField label={field.label} value={value} disabled={disabled} onChange={onChange} />;
  if (field.kind === 'times') return <TimesField label={field.label} helper={field.helper} value={value} disabled={disabled} onChange={onChange} />;
  if (field.kind === 'cards') return <CardsField field={field} value={value} disabled={disabled} onChange={onChange} />;
  // A saved value that isn't one of the choices still shows (as "custom").
  const options = field.options && value !== '' && !field.options.some((o) => o.value === value) ? [...field.options, opt(value, `${value} (custom)`)] : field.options;
  return (
    <TextField
      fullWidth
      multiline={field.multiline}
      minRows={field.multiline ? 2 : undefined}
      size="small"
      label={field.label}
      value={value}
      disabled={disabled}
      select={field.kind === 'select'}
      type={field.kind === 'number' ? 'number' : field.kind === 'color' ? 'color' : 'text'}
      helperText={field.helper}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{ input: field.unit ? { endAdornment: <Typography variant="caption" color="text.secondary">{field.unit}</Typography> } : undefined }}
    >
      {options?.map((o) => (
        <MenuItem key={o.value} value={o.value}>
          {o.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** One settings card; advanced fields stay folded away until asked for. */
export function GroupCard({ group, draft, canEdit, onChange }: { group: Group; draft: Draft; canEdit: boolean; onChange: (f: FieldDef, raw: string) => void }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const visible = group.fields.filter((f) => !f.showIf || f.showIf(draft));
  const advancedCount = visible.filter((f) => f.advanced).length;
  const fields = visible.filter((f) => !f.advanced || showAdvanced);
  const note = group.note?.(draft);
  return (
    <Card variant="outlined">
      <CardHeader title={group.title} subheader={group.description} slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } }, subheader: { variant: 'body2' } }} />
      <CardContent sx={{ pt: 0 }}>
        {note && <Box sx={{ mb: 2 }}>{note}</Box>}
        <Grid container spacing={2.5}>
          {fields.map((f) => (
            <Grid key={`${f.section}.${f.key}`} size={{ xs: 12, sm: f.width === 'full' || f.multiline ? 12 : f.width === 'third' ? 4 : 6 }}>
              <FieldInput field={f} draft={draft} canEdit={canEdit} onChange={(raw) => onChange(f, raw)} />
            </Grid>
          ))}
        </Grid>
        {advancedCount > 0 && (
          <Button size="small" sx={{ mt: 1.5 }} onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Hide advanced settings' : `Show advanced settings (${advancedCount})`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
