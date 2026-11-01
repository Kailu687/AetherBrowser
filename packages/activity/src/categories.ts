import { getDomain, getHostname } from 'tldts';
import type { Category } from './types.js';

const BY_DOMAIN: Record<string, Category> = {};
const add = (category: Category, domains: string[]) => domains.forEach((d) => (BY_DOMAIN[d] = category));

add('education', [
  'coursera.org', 'edx.org', 'khanacademy.org', 'nptel.ac.in', 'swayam.gov.in', 'udemy.com', 'brilliant.org',
  'mit.edu', 'ocw.mit.edu', 'geeksforgeeks.org', 'w3schools.com', 'byjus.com', 'unacademy.com', 'duolingo.com',
  'instructure.com', 'moodle.org', 'blackboard.com', 'classroom.google.com', 'wikipedia.org', 'libretexts.org', 'allaboutcircuits.com',
  'electronics-tutorials.ws',
]);
add('research', [
  'arxiv.org', 'scholar.google.com', 'ieee.org', 'ieeexplore.ieee.org', 'sciencedirect.com', 'springer.com', 'nature.com',
  'acm.org', 'semanticscholar.org', 'researchgate.net', 'doi.org', 'crossref.org', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov',
  'jstor.org', 'wiley.com', 'tandfonline.com', 'mdpi.com', 'plos.org', 'biorxiv.org', 'paperswithcode.com', 'zotero.org',
  'openreview.net', 'sae.org', 'aiaa.org', 'iop.org', 'ti.com', 'analog.com', 'st.com', 'microchip.com', 'nxp.com', 'infineon.com',
  'alldatasheet.com', 'datasheetarchive.com', 'mouser.com', 'digikey.com', 'digikey.in',
]);
add('productivity', [
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'developer.mozilla.org', 'docs.python.org',
  'npmjs.com', 'pypi.org', 'readthedocs.io', 'notion.so', 'docs.google.com', 'drive.google.com', 'sheets.google.com',
  'overleaf.com', 'figma.com', 'trello.com', 'atlassian.net', 'linear.app', 'vercel.com', 'netlify.com', 'aws.amazon.com',
  'console.cloud.google.com', 'portal.azure.com', 'claude.ai', 'chatgpt.com', 'kaggle.com', 'colab.research.google.com',
  'wolframalpha.com', 'desmos.com', 'mathworks.com', 'onshape.com', 'falstad.com', 'easyeda.com', 'calendar.google.com',
]);
add('communication', [
  'mail.google.com', 'outlook.office.com', 'outlook.live.com', 'web.whatsapp.com', 'whatsapp.com', 'slack.com', 'teams.microsoft.com',
  'discord.com', 'web.telegram.org', 'telegram.org', 'zoom.us', 'meet.google.com', 'messenger.com', 'proton.me', 'linkedin.com',
]);
add('social', [
  'instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'tiktok.com', 'snapchat.com', 'reddit.com', 'threads.net',
  'pinterest.com', 'tumblr.com', 'quora.com', 'bsky.app', 'mastodon.social',
]);
add('entertainment', [
  'netflix.com', 'primevideo.com', 'hotstar.com', 'jiocinema.com', 'twitch.tv', 'spotify.com', 'music.youtube.com',
  'disneyplus.com', 'hulu.com', 'crunchyroll.com', '9gag.com', 'imdb.com', 'steampowered.com', 'epicgames.com', 'sonyliv.com',
]);

const EDU_SUFFIX = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/;

/**
 * Categorises a URL. Overrides win, then the most specific hostname match (so
 * scholar.google.com is research while google.com is not), then academic TLDs.
 * YouTube is path-aware: Shorts count as entertainment, other videos stay
 * uncategorized because they are often lectures; users can override.
 */
export function categorize(url: string, overrides: Record<string, Category> = {}): Category {
  const host = (getHostname(url) ?? '').toLowerCase().replace(/^www\./, '');
  if (!host) return 'uncategorized';
  const domain = getDomain(url) ?? host;
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (overrides[candidate]) return overrides[candidate]!;
  }
  if (domain === 'youtube.com' && host !== 'music.youtube.com') {
    try {
      if (new URL(url).pathname.startsWith('/shorts')) return 'entertainment';
    } catch {
      // fall through
    }
    return 'uncategorized';
  }
  for (let i = 0; i < labels.length - 1; i++) {
    const c = BY_DOMAIN[labels.slice(i).join('.')];
    if (c) return c;
  }
  if (EDU_SUFFIX.test(host)) return 'education';
  return 'uncategorized';
}
