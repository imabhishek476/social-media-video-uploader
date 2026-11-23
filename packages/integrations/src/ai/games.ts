/**
 * Games we recognise from a stream title (or a streamer's setting). Knowing
 * the game lets the AI judge moments the way that game's audience would, and
 * every post carries the hashtags people actually search for.
 */
export interface GameInfo {
  name: string;
  hashtags: string[];
}

const G = (name: string, pattern: RegExp, hashtags: string[]) => ({ name, pattern, hashtags });

// Order matters: more specific titles first (GTA VI before GTA V).
const GAMES = [
  G('Grand Theft Auto VI', /\b(gta\s*(6|vi)|grand theft auto\s*(6|vi))\b/i, ['GTA6', 'GTAVI', 'ViceCity', 'RockstarGames']),
  G('GTA RP', /\b(gta\s*(5|v)?\s*rp|nopixel|soulcity|soul city|roleplay)\b/i, ['GTARP', 'GTA5RP', 'GTARoleplay']),
  G('Grand Theft Auto V', /\b(gta\s*(5|v|online)|grand theft auto\s*(5|v))\b/i, ['GTA5', 'GTAOnline', 'GTAV']),
  G('BGMI', /\b(bgmi|battlegrounds mobile)\b/i, ['BGMI', 'BGMIClips', 'BGMIIndia']),
  G('PUBG', /\bpubg\b/i, ['PUBG', 'PUBGMobile']),
  G('Free Fire', /\bfree\s*fire\b/i, ['FreeFire', 'FreeFireMax']),
  G('Valorant', /\bvalorant\b/i, ['Valorant', 'ValorantClips']),
  G('Counter-Strike 2', /\b(cs\s*2|cs2|counter[- ]strike|csgo)\b/i, ['CS2', 'CounterStrike']),
  G('Minecraft', /\bminecraft\b/i, ['Minecraft', 'MinecraftFunny']),
  G('Fortnite', /\bfortnite\b/i, ['Fortnite', 'FortniteClips']),
  G('Call of Duty', /\b(call of duty|cod|warzone|black ops)\b/i, ['CallOfDuty', 'Warzone']),
  G('Apex Legends', /\bapex\b/i, ['ApexLegends']),
  G('League of Legends', /\b(league of legends|\blol\b)\b/i, ['LeagueOfLegends']),
  G('Elden Ring', /\belden ring\b/i, ['EldenRing']),
  G('Marvel Rivals', /\bmarvel rivals\b/i, ['MarvelRivals']),
  G('Rocket League', /\brocket league\b/i, ['RocketLeague']),
  G('Roblox', /\broblox\b/i, ['Roblox']),
  G('Among Us', /\bamong us\b/i, ['AmongUs']),
  G('Red Dead Redemption', /\b(rdr\s*2|red dead)\b/i, ['RDR2', 'RedDeadRedemption']),
  G('Cyberpunk 2077', /\bcyberpunk\b/i, ['Cyberpunk2077']),
  G('Clash of Clans', /\bclash of clans|\bcoc\b/i, ['ClashOfClans']),
  G('Chess', /\bchess\b/i, ['Chess', 'ChessClips']),
];

/** First game found in these texts (streamer setting first, then titles). */
export function detectGame(...texts: Array<string | null | undefined>): GameInfo | null {
  for (const t of texts) {
    if (!t) continue;
    const exact = GAMES.find((g) => g.name.toLowerCase() === t.trim().toLowerCase());
    if (exact) return { name: exact.name, hashtags: exact.hashtags };
    const hit = GAMES.find((g) => g.pattern.test(t));
    if (hit) return { name: hit.name, hashtags: hit.hashtags };
  }
  return null;
}

export const knownGames = () => GAMES.map((g) => g.name);

/** Extra instructions for the highlight picker when the game is known. */
export function gameRules(game: GameInfo): string {
  return [
    `This stream is ${game.name}. Judge moments the way its players would:`,
    '- A play, a kill, a death, a clutch, a fail, a glitch, a jump scare, a discovery, or the streamer reacting to one.',
    '- The hook names what happened in two to six words ("1 VS 3", "HE GOT ME", "CLUTCH") or quotes what was said. Never a sentence that needs the game explained.',
    `- Lines tagged (CLIP REQUEST) are where the streamer or chat asked for a clip: weigh them strongly.`,
  ].join('\n');
}
