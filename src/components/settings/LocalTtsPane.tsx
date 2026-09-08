import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/locale';
import { previewLocalTts } from '../../../shared/local-tts/client';
import { isLocalTtsVoice, LOCAL_TTS_SAMPLE } from '../../../shared/local-tts/contract';
import type { FieldCtx } from './settingsVendorPane';
import { LocalModelPackPane } from './LocalModelPackPane';

export function LocalTtsPane({ ctx }: { ctx: FieldCtx }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const voice = ctx.values.LOCAL_TTS_VOICE ?? ctx.status?.models.LOCAL_TTS_VOICE ?? '';
  const speed = Number(ctx.values.LOCAL_TTS_SPEED ?? ctx.status?.models.LOCAL_TTS_SPEED ?? '') || 1;
  const status = ctx.status?.localTts;
  const cleanup = () => {
    controller.current?.abort();
    controller.current = null;
    audio.current?.pause();
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.removeAttribute('src');
      audio.current.load();
    }
    audio.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  };
  const stop = () => { cleanup(); setBusy(false); };
  useEffect(() => {
    cleanup();
    setBusy(false);
    setError('');
    return cleanup;
  }, [voice, speed]);
  useEffect(() => {
    void ctx.refreshStatus();
    const timer = window.setInterval(() => { void ctx.refreshStatus(); }, 1500);
    return () => window.clearInterval(timer);
  }, [ctx.refreshStatus]);
  async function audition() {
    if (!isLocalTtsVoice(voice)) return;
    cleanup();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      const blob = await previewLocalTts(voice, speed, { signal: request.signal });
      request.signal.throwIfAborted();
      url.current = URL.createObjectURL(blob);
      const player = new Audio(url.current);
      audio.current = player;
      player.onended = stop;
      player.onerror = () => { stop(); setError(t('试听播放失败')); };
      await player.play();
    } catch (cause) {
      if (!request.signal.aborted) { stop(); setError(cause instanceof Error ? cause.message : String(cause)); }
    }
  }
  const label = !status ? '读取中…' : !status.supported ? '仅支持 Apple Silicon Mac'
    : status.state === 'loading' ? '正在加载本地配音模型…'
      : status.state === 'generating' ? '正在生成本地配音…'
        : status.available ? '已安装，使用时自动加载' : '请先下载配音模型';
  return <section style={{ fontSize: 12 }}>
    <p role="status">{t(label)}</p>
    <p>{t('下载模型不会更改默认配音供应商。安装后无需 API Key，生成时不会联网下载。')}</p>
    <p>{t('试听使用固定英文示例，不保存到媒体池。')}</p>
    <blockquote lang="en">{LOCAL_TTS_SAMPLE}</blockquote>
    <button type="button" onClick={() => { if (busy) stop(); else void audition(); }}
      disabled={!busy && (!status?.available || !isLocalTtsVoice(voice))}>
      {busy ? t('停止试听') : t('试听音色')}
    </button>
    {error && <p role="alert">{error}</p>}
    {status?.error && <p role="alert">{status.error} <button type="button" onClick={() => {
      void fetch('/api/local-tts/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(() => ctx.refreshStatus()).catch((cause: unknown) => setError(String(cause)));
    }}>{t('重试')}</button></p>}
    {status?.supported && <LocalModelPackPane packIds={['kokoro-en']} title="Kokoro 英语配音包"
      description="模型不会自动安装。请点击下载；已生成的音频不会因删除模型而丢失。" />}
    <p>{t('模型权重为 Apache-2.0；语音运行时包含 GPL eSpeak 组件，详见第三方声明。')}</p>
    <a href="/licenses/local-tts/NOTICE.txt" target="_blank" rel="noreferrer">{t('第三方声明')}</a>
  </section>;
}
