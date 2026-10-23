import { createHash } from 'node:crypto';

const BASE = 'https://api.music.yandex.net';
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiAAA';
const CLIENT_HEADER = 'YandexMusicAndroid/2025.10.2+1032 mp-android/34';

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`));
  return match ? match[1] : null;
}

export class YandexMusicClient {
  constructor(token, baseUrl = BASE) {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  headers() {
    return {
      Accept: 'application/json',
      Authorization: `OAuth ${this.token}`,
      'X-Yandex-Music-Client': CLIENT_HEADER,
    };
  }

  async request(path) {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Yandex Music ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async searchTracks(query, limit = 10) {
    const data = await this.request(
      `/search?text=${encodeURIComponent(query)}&type=track&page=1&pageSize=${limit}`,
    );
    const tracks = data?.result?.tracks?.results ?? [];
    return tracks.map((track) => ({
      id: track.id,
      albumId: track.albums?.[0]?.id ?? null,
      title: track.title ?? 'Без названия',
      artists: (track.artists ?? []).map((artist) => artist.name).filter(Boolean).join(', '),
      durationMs: track.durationMs ?? 0,
    }));
  }

  async playableUrl(trackId) {
    const data = await this.request(`/tracks/${trackId}/download-info`);
    const infos = (data?.result ?? []).map((item) => ({
      codec: item.codec,
      bitrate: item.bitrateInKbps ?? 0,
      url: item.downloadInfoUrl,
    }));
    if (!infos.length) throw new Error('Не удалось получить ссылки на трек');

    const [best] = infos
      .filter((info) => info.codec === 'mp3' && info.url)
      .sort((a, b) => b.bitrate - a.bitrate);
    const info = best ?? infos.find((i) => i.url);
    if (!info) throw new Error('Нет mp3-вариантов у трека');

    const res = await fetch(info.url);
    if (!res.ok) throw new Error(`download-info XML ${res.status}`);
    const xml = await res.text();

    const host = xmlValue(xml, 'host');
    const path = xmlValue(xml, 'path');
    const ts = xmlValue(xml, 'ts');
    const s = xmlValue(xml, 's');
    if (!host || !path || !s) throw new Error('Неожиданный XML download-info');

    const sign = createHash('md5').update(SIGN_SALT + path.slice(1) + s).digest('hex');
    return `https://${host}/get-mp3/${sign}/${ts}${path}`;
  }
}
