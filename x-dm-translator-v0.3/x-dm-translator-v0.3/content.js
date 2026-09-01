(() => {
  'use strict';

  if (window.top !== window) return;

  const DEFAULTS = {
    enabled: true,
    autoTranslate: true,
    outgoingTarget: 'en',
    minConfidence: 0.45
  };

  const INCOMING_TARGET = 'zh';
  const OUTGOING_SOURCE = 'zh';
  const MAX_MESSAGE_LENGTH = 6000;
  const MAX_CHUNK_LENGTH = 1200;
  const LANGUAGE_NAMES = {
    zh: '中文',
    'zh-Hant': '繁体中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    es: '西班牙语',
    fr: '法语',
    de: '德语',
    ru: '俄语',
    pt: '葡萄牙语',
    it: '意大利语',
    ar: '阿拉伯语',
    th: '泰语',
    vi: '越南语',
    id: '印度尼西亚语',
    tr: '土耳其语',
    und: '未知语言'
  };

  let settings = { ...DEFAULTS };
  let apiState = 'checking';
  let detectorSession = null;
  let detectorPromise = null;
  const translatorPromises = new Map();
  let messageState = new WeakMap();
  let messageUi = new WeakMap();
  let scanTimer = null;
  let scanDueAt = 0;
  let previousPath = location.pathname;

  const taskQueue = [];
  let runningTasks = 0;
  const MAX_CONCURRENT_TASKS = 2;

  function makeError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  }

  function languageName(code) {
    return LANGUAGE_NAMES[normalizeLanguage(code)] || code || '未知语言';
  }

  function normalizeLanguage(code) {
    if (!code) return 'und';
    const normalized = String(code).trim();
    const lower = normalized.toLowerCase();

    if (['zh-cn', 'zh-sg', 'zh-hans', 'cmn-hans', 'cmn'].includes(lower)) return 'zh';
    if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].includes(lower)) return 'zh-Hant';
    if (lower.startsWith('en-')) return 'en';
    if (lower.startsWith('ja-')) return 'ja';
    if (lower.startsWith('ko-')) return 'ko';
    if (lower.startsWith('es-')) return 'es';
    if (lower.startsWith('fr-')) return 'fr';
    if (lower.startsWith('de-')) return 'de';
    if (lower.startsWith('ru-')) return 'ru';
    if (lower.startsWith('pt-')) return 'pt';
    if (lower.startsWith('it-')) return 'it';
    if (lower.startsWith('ar-')) return 'ar';
    if (lower.startsWith('th-')) return 'th';
    if (lower.startsWith('vi-')) return 'vi';
    if (lower.startsWith('id-')) return 'id';
    if (lower.startsWith('tr-')) return 'tr';
    return normalized;
  }

  function isChinese(code) {
    return normalizeLanguage(code).toLowerCase().startsWith('zh');
  }

  function isDmPage() {
    const path = location.pathname;
    return path.startsWith('/messages') || path.startsWith('/i/chat');
  }

  function setToolbarStatus(text) {
    const status = document.querySelector('#xdmt-toolbar .xdmt-status');
    if (status) status.textContent = text;
  }

  function updateToolbar() {
    const toolbar = ensureToolbar();
    if (!toolbar) return;

    toolbar.classList.toggle('xdmt-hidden', !settings.enabled || !isDmPage());

    const initButton = toolbar.querySelector('[data-xdmt-action="init"]');
    const composerButton = toolbar.querySelector('[data-xdmt-action="composer"]');

    if (initButton) {
      initButton.hidden = apiState === 'ready';
      initButton.disabled = apiState === 'initializing';
      initButton.textContent = apiState === 'initializing'
        ? '正在初始化…'
        : '初始化本地翻译';
    }

    if (composerButton) {
      composerButton.disabled = apiState !== 'ready';
      composerButton.textContent = `翻译输入框：中文 → ${languageName(settings.outgoingTarget)}`;
    }

    const statusText = {
      checking: '正在检查 Edge 翻译能力',
      'needs-init': '首次使用需要初始化',
      initializing: '正在下载或加载模型',
      ready: '本地翻译已就绪',
      unavailable: '当前 Edge 不支持该 API',
      error: '初始化失败'
    }[apiState] || apiState;

    setToolbarStatus(statusText);
  }

  function ensureToolbar() {
    let toolbar = document.querySelector('#xdmt-toolbar');
    if (toolbar) return toolbar;
    if (!document.body) return null;

    toolbar = document.createElement('section');
    toolbar.id = 'xdmt-toolbar';
    toolbar.dataset.xdmtUi = 'true';
    toolbar.innerHTML = `
      <div class="xdmt-toolbar-head">
        <span>X 私信翻译助手 <small style="font-size:10px;opacity:.58">V0.3</small></span>
        <span class="xdmt-status">正在检查</span>
      </div>
      <div class="xdmt-row">
        <button class="xdmt-button xdmt-grow" type="button" data-xdmt-action="init">初始化本地翻译</button>
      </div>
      <div class="xdmt-row">
        <button class="xdmt-button xdmt-grow" type="button" data-xdmt-action="rescan">翻译当前已加载消息</button>
      </div>
      <div class="xdmt-row">
        <button class="xdmt-button xdmt-grow" type="button" data-xdmt-action="composer">翻译输入框</button>
      </div>
      <div class="xdmt-preview" hidden>
        <div class="xdmt-meta">发送前预览；扩展不会自动发送</div>
        <textarea aria-label="翻译结果预览"></textarea>
        <div class="xdmt-row">
          <button class="xdmt-button xdmt-grow" type="button" data-xdmt-action="replace">替换 X 输入框</button>
          <button class="xdmt-button secondary" type="button" data-xdmt-action="copy-preview">复制译文</button>
          <button class="xdmt-button secondary" type="button" data-xdmt-action="close-preview">关闭</button>
        </div>
      </div>
    `;

    toolbar.querySelector('[data-xdmt-action="init"]').addEventListener('click', initializeByUserGesture);
    toolbar.querySelector('[data-xdmt-action="rescan"]').addEventListener('click', rescanLoadedMessagesByUserGesture);
    toolbar.querySelector('[data-xdmt-action="composer"]').addEventListener('click', translateComposerByUserGesture);
    toolbar.querySelector('[data-xdmt-action="replace"]').addEventListener('click', replaceComposerFromPreview);
    toolbar.querySelector('[data-xdmt-action="copy-preview"]').addEventListener('click', copyPreviewText);
    toolbar.querySelector('[data-xdmt-action="close-preview"]').addEventListener('click', () => {
      toolbar.querySelector('.xdmt-preview').hidden = true;
    });

    document.body.append(toolbar);
    return toolbar;
  }

  function enqueueTask(task) {
    return new Promise((resolve, reject) => {
      taskQueue.push({ task, resolve, reject });
      pumpQueue();
    });
  }

  function pumpQueue() {
    while (runningTasks < MAX_CONCURRENT_TASKS && taskQueue.length > 0) {
      const item = taskQueue.shift();
      runningTasks += 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          runningTasks -= 1;
          pumpQueue();
        });
    }
  }

  function startDetectorCreation(onProgress) {
    if (detectorSession) return Promise.resolve(detectorSession);
    if (detectorPromise) return detectorPromise;
    if (!('LanguageDetector' in globalThis)) {
      return Promise.reject(makeError('API_UNAVAILABLE', 'LanguageDetector API 不可用'));
    }

    let creation;
    try {
      creation = globalThis.LanguageDetector.create({
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            onProgress?.(progressPercent(event));
          });
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }

    detectorPromise = Promise.resolve(creation)
      .then((session) => {
        detectorSession = session;
        return session;
      })
      .catch((error) => {
        detectorPromise = null;
        throw error;
      });

    return detectorPromise;
  }

  function translatorKey(sourceLanguage, targetLanguage) {
    return `${normalizeLanguage(sourceLanguage)}→${normalizeLanguage(targetLanguage)}`;
  }

  function startTranslatorCreation(sourceLanguage, targetLanguage, onProgress) {
    const source = normalizeLanguage(sourceLanguage);
    const target = normalizeLanguage(targetLanguage);

    if (source === target || (isChinese(source) && isChinese(target))) {
      return Promise.resolve(null);
    }

    if (!('Translator' in globalThis)) {
      return Promise.reject(makeError('API_UNAVAILABLE', 'Translator API 不可用'));
    }

    const key = translatorKey(source, target);
    if (translatorPromises.has(key)) return translatorPromises.get(key);

    let creation;
    try {
      creation = globalThis.Translator.create({
        sourceLanguage: source,
        targetLanguage: target,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            onProgress?.(progressPercent(event));
          });
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }

    const promise = Promise.resolve(creation).catch((error) => {
      translatorPromises.delete(key);
      throw error;
    });

    translatorPromises.set(key, promise);
    return promise;
  }

  function progressPercent(event) {
    if (Number.isFinite(event.total) && event.total > 0) {
      return Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
    }
    if (Number.isFinite(event.loaded) && event.loaded >= 0 && event.loaded <= 1) {
      return Math.round(event.loaded * 100);
    }
    return null;
  }

  async function ensureDetectorAutomatically() {
    if (detectorSession) return detectorSession;
    if (detectorPromise) return detectorPromise;
    if (!('LanguageDetector' in globalThis)) {
      throw makeError('API_UNAVAILABLE', 'LanguageDetector API 不可用');
    }

    const availability = await globalThis.LanguageDetector.availability();
    if (availability !== 'available') {
      throw makeError('DETECTOR_DOWNLOAD_REQUIRED', '语言识别模型需要用户初始化');
    }

    return startDetectorCreation();
  }

  async function ensureTranslatorAutomatically(sourceLanguage, targetLanguage) {
    const source = normalizeLanguage(sourceLanguage);
    const target = normalizeLanguage(targetLanguage);
    const key = translatorKey(source, target);

    if (translatorPromises.has(key)) return translatorPromises.get(key);
    if (!('Translator' in globalThis)) {
      throw makeError('API_UNAVAILABLE', 'Translator API 不可用');
    }

    const availability = await globalThis.Translator.availability({
      sourceLanguage: source,
      targetLanguage: target
    });

    if (availability === 'unavailable') {
      throw makeError(
        'PAIR_UNAVAILABLE',
        `${languageName(source)}到${languageName(target)}的语言组合不受支持`,
        { source, target }
      );
    }

    if (availability !== 'available') {
      throw makeError(
        'TRANSLATOR_DOWNLOAD_REQUIRED',
        '该语言模型需要用户点击下载',
        { source, target }
      );
    }

    return startTranslatorCreation(source, target);
  }

  async function initializeByUserGesture() {
    if (apiState === 'initializing') return;
    apiState = 'initializing';
    updateToolbar();

    const progress = (percent) => {
      setToolbarStatus(percent === null ? '正在下载模型' : `正在下载模型 ${percent}%`);
    };

    // 必须在第一次 await 之前发起 create()，以保留用户点击带来的激活状态。
    const detectorTask = startDetectorCreation(progress);
    const incomingEnglishTask = startTranslatorCreation('en', INCOMING_TARGET, progress);
    const outgoingTask = startTranslatorCreation(OUTGOING_SOURCE, settings.outgoingTarget, progress);

    const [detectorResult] = await Promise.allSettled([
      detectorTask,
      incomingEnglishTask,
      outgoingTask
    ]);

    if (detectorResult.status === 'rejected') {
      apiState = 'error';
      updateToolbar();
      setToolbarStatus(readableError(detectorResult.reason));
      return;
    }

    apiState = 'ready';
    updateToolbar();
    messageState = new WeakMap();
    scheduleScan(0);
  }

  async function bootstrapApi() {
    ensureToolbar();

    if (!('Translator' in globalThis) || !('LanguageDetector' in globalThis)) {
      apiState = 'unavailable';
      updateToolbar();
      return;
    }

    try {
      const availability = await globalThis.LanguageDetector.availability();
      if (availability !== 'available') {
        apiState = 'needs-init';
        updateToolbar();
        return;
      }

      await startDetectorCreation();
      apiState = 'ready';
      updateToolbar();
      scheduleScan(0);
    } catch (error) {
      apiState = error?.name === 'NotAllowedError' ? 'needs-init' : 'error';
      updateToolbar();
      if (apiState === 'error') setToolbarStatus(readableError(error));
    }
  }

  async function detectLanguage(text) {
    const detector = await ensureDetectorAutomatically();
    const results = await detector.detect(text);
    const best = results.find((item) => item.detectedLanguage !== 'und') || results[0];

    return {
      source: normalizeLanguage(best?.detectedLanguage || 'und'),
      confidence: Number(best?.confidence || 0)
    };
  }

  function splitText(text) {
    if (text.length <= MAX_CHUNK_LENGTH) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > MAX_CHUNK_LENGTH) {
      const windowText = remaining.slice(0, MAX_CHUNK_LENGTH);
      const splitAt = Math.max(
        windowText.lastIndexOf('\n'),
        windowText.lastIndexOf('。'),
        windowText.lastIndexOf('！'),
        windowText.lastIndexOf('？'),
        windowText.lastIndexOf('. '),
        windowText.lastIndexOf('! '),
        windowText.lastIndexOf('? '),
        windowText.lastIndexOf(' ')
      );

      const safeIndex = splitAt > MAX_CHUNK_LENGTH * 0.45 ? splitAt + 1 : MAX_CHUNK_LENGTH;
      chunks.push(remaining.slice(0, safeIndex).trim());
      remaining = remaining.slice(safeIndex).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks.filter(Boolean);
  }

  async function translateWithSession(session, text) {
    if (!session) return text;
    const chunks = splitText(text);
    const translated = [];

    for (const chunk of chunks) {
      translated.push(await session.translate(chunk));
    }

    return translated.join('\n').trim();
  }

  const MESSAGE_ENTRY_SELECTOR = [
    '[data-testid="messageEntry"]',
    '[data-testid="dmMessage"]',
    '[data-testid="messageBubble"]',
    '[data-testid*="messageentry" i]',
    '[data-testid*="message-entry" i]',
    '[data-testid*="messagebubble" i]',
    '[data-testid*="dmmessage" i]'
  ].join(', ');

  const MESSAGE_TEXT_SELECTOR = [
    '[data-testid="messageText"]',
    '[data-testid="tweetText"]',
    '[data-testid="dmMessageText"]',
    '[data-testid*="messagetext" i]',
    '[data-testid*="message-text" i]'
  ].join(', ');

  function findMessageTextElement(entry) {
    const preferred = entry.querySelector(MESSAGE_TEXT_SELECTOR);
    if (preferred && !preferred.closest('[data-xdmt-ui="true"]')) return preferred;

    const candidates = [...entry.querySelectorAll('[lang][dir="auto"], div[dir="auto"]')]
      .filter((element) => {
        if (element.closest('[data-xdmt-ui="true"]')) return false;
        if (element.closest('button, [role="button"], time')) return false;
        const text = extractMessageText(element);
        if (!text || text.length > MAX_MESSAGE_LENGTH) return false;

        return ![...element.children].some((child) => {
          if (!child.matches?.('[lang][dir="auto"], div[dir="auto"]')) return false;
          return extractMessageText(child) === text;
        });
      });

    candidates.sort((a, b) => {
      const aText = extractMessageText(a);
      const bText = extractMessageText(b);
      const aScore = aText.length + (a.hasAttribute('lang') ? 1000 : 0);
      const bScore = bText.length + (b.hasAttribute('lang') ? 1000 : 0);
      return bScore - aScore;
    });

    return candidates[0] || null;
  }

  function isLikelyMessageFallback(element, composerRect) {
    if (!element?.isConnected || element.closest('[data-xdmt-ui="true"]')) return false;
    if (element.closest('button, [role="button"], time, nav, header, aside, form')) return false;
    if (element.matches('[contenteditable="true"], textarea, input')) return false;
    if (element.closest('[contenteditable="true"]')) return false;

    const text = extractMessageText(element);
    if (shouldIgnoreText(text)) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;

    if (composerRect) {
      const overlap = Math.min(rect.right, composerRect.right) - Math.max(rect.left, composerRect.left);
      const overlapRatio = overlap / Math.max(1, Math.min(rect.width, composerRect.width));
      if (overlapRatio < 0.45) return false;
      if (rect.top >= composerRect.bottom + 20) return false;
      if (rect.bottom <= 45) return false;
      if (rect.width > composerRect.width * 0.98) return false;
    }

    const messageLikeAncestor = element.closest(
      '[data-testid*="message" i], [data-testid*="dm" i], [role="listitem"]'
    );
    if (messageLikeAncestor) return true;

    // 新版 X Chat 的消息正文有时只保留 lang/dir 属性，不再使用旧 data-testid。
    return element.hasAttribute('lang') && element.getAttribute('dir') === 'auto';
  }

  function collectMessageTextElements() {
    const elements = new Set();

    document.querySelectorAll(MESSAGE_ENTRY_SELECTOR).forEach((entry) => {
      const textElement = findMessageTextElement(entry);
      if (textElement) elements.add(textElement);
    });

    document.querySelectorAll(MESSAGE_TEXT_SELECTOR).forEach((element) => {
      if (!element.closest('[data-xdmt-ui="true"]')) elements.add(element);
    });

    // 兼容未使用旧 data-testid 的 X Chat 页面。以输入框横向范围限制候选，
    // 避免把左侧会话列表和导航文字误认为私信正文。
    const composer = findComposer();
    const composerRect = composer?.getBoundingClientRect() || null;
    const root = composer?.closest('main, [role="main"]') || document.querySelector('main, [role="main"]') || document;
    root.querySelectorAll('[lang][dir="auto"], [lang][dir="ltr"], [lang][dir="rtl"]').forEach((element) => {
      if (isLikelyMessageFallback(element, composerRect)) elements.add(element);
    });

    return [...elements];
  }

  function cleanText(text) {
    return String(text)
      .replace(/\u200B/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const MESSAGE_METADATA_SELECTOR = [
    '[data-xdmt-ui="true"]',
    'time',
    'svg',
    'button',
    '[role="button"]',
    '[aria-hidden="true"]',
    '[data-testid*="timestamp" i]',
    '[data-testid*="time-stamp" i]',
    '[data-testid*="readreceipt" i]',
    '[data-testid*="read-receipt" i]',
    '[data-testid*="delivery" i]',
    '[data-testid*="messagestatus" i]',
    '[data-testid*="message-status" i]'
  ].join(', ');

  const CLOCK_TOKEN_PATTERN = String.raw`(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?(?:a\.?m\.?|p\.?m\.?))?`;
  const DELIVERY_STATUS_PATTERN = String.raw`(?:sent|sending|delivered|read|seen|failed|已发送|发送中|已送达|已读|发送失败)`;
  const CLOCK_TOKEN_RE = new RegExp(`^${CLOCK_TOKEN_PATTERN}$`, 'iu');
  const CLOCK_GLOBAL_RE = new RegExp(CLOCK_TOKEN_PATTERN, 'giu');
  const STATUS_TOKEN_RE = new RegExp(`^${DELIVERY_STATUS_PATTERN}$`, 'iu');
  const STATUS_CLOCK_COMBO_RE = new RegExp(
    `^(?:(?:${DELIVERY_STATUS_PATTERN})\\s*)?(?:${CLOCK_TOKEN_PATTERN})(?:\\s*(?:${DELIVERY_STATUS_PATTERN}))?$`,
    'iu'
  );

  function removeDomIconNoise(text) {
    return String(text)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      .replace(/[\uFE0E\uFE0F]/g, '')
      .replace(/[\uE000-\uF8FF]/g, '')
      .replace(/[\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '');
  }

  function normalizeClockToken(value) {
    return String(value).toLowerCase().replace(/[\s.]/g, '');
  }

  function clockTokens(text) {
    return [...String(text).matchAll(CLOCK_GLOBAL_RE)].map((match) => normalizeClockToken(match[0]));
  }

  function isOnlyMessageMetadata(text) {
    const value = cleanText(removeDomIconNoise(text)).replace(/\s+/g, ' ').trim();
    if (!value) return true;
    if (CLOCK_TOKEN_RE.test(value) || STATUS_TOKEN_RE.test(value)) return true;

    const withoutReceiptIcons = value
      .replace(/[✓✔☑☒●○◉◌·•|]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!withoutReceiptIcons) return true;
    if (STATUS_CLOCK_COMBO_RE.test(withoutReceiptIcons)) return true;
    return /^[\p{P}\p{S}\s]+$/u.test(withoutReceiptIcons);
  }

  function isMetadataSeparator(text) {
    const value = removeDomIconNoise(text)
      .replace(new RegExp(DELIVERY_STATUS_PATTERN, 'giu'), '')
      .replace(/[✓✔☑☒●○◉◌·•|]/gu, '')
      .replace(/[\s\u00A0,;，；。.!！?？()（）[\]{}<>《》“”'"—–_-]/gu, '');
    return value.length === 0;
  }

  function stripRepeatedTrailingClockMetadata(text) {
    let current = text;

    // 新版 X Chat 偶尔会把同一个时间同时放在可见节点和辅助节点中。
    // 只在末尾出现两个相同时间、且两者之间没有正文时删除，避免误删“明天 18:30 见”之类的消息。
    for (let pass = 0; pass < 3; pass += 1) {
      const matches = [...current.matchAll(CLOCK_GLOBAL_RE)];
      if (matches.length < 2) break;

      const previous = matches[matches.length - 2];
      const last = matches[matches.length - 1];
      const previousClock = normalizeClockToken(previous[0]);
      const lastClock = normalizeClockToken(last[0]);
      const between = current.slice(previous.index + previous[0].length, last.index);
      const after = current.slice(last.index + last[0].length);
      const prefix = current.slice(0, previous.index).trimEnd();

      if (
        previousClock === lastClock &&
        /[\p{L}\p{N}]/u.test(prefix) &&
        isMetadataSeparator(between) &&
        isMetadataSeparator(after)
      ) {
        current = prefix;
        continue;
      }
      break;
    }

    return current;
  }

  function stripTrailingClockAlreadyRemovedElsewhere(text, removedClocks) {
    let current = text;
    if (!removedClocks.size) return current;

    const trailingClockRe = new RegExp(
      `(?:[\\s\\u00A0·•|✓✔☑☒—–_-]+)(${CLOCK_TOKEN_PATTERN})(?:[\\s\\u00A0·•|✓✔☑☒—–_-]*)$`,
      'iu'
    );

    for (let pass = 0; pass < 2; pass += 1) {
      const match = trailingClockRe.exec(current);
      if (!match) break;

      const prefix = current.slice(0, match.index).trimEnd();
      const clock = normalizeClockToken(match[1]);
      if (!removedClocks.has(clock) || !/[\p{L}\p{N}]/u.test(prefix)) break;
      current = prefix;
    }

    return current;
  }

  function extractMessageText(element) {
    if (!element) return '';

    const clone = element.cloneNode(true);
    const removedClocks = new Set();

    const rememberClocks = (node) => {
      for (const clock of clockTokens(node?.textContent || '')) removedClocks.add(clock);
    };

    clone.querySelectorAll(MESSAGE_METADATA_SELECTOR).forEach((node) => {
      rememberClocks(node);
      node.remove();
    });

    // 时间和“已读/已送达”不一定带稳定的 data-testid；从最深层节点开始，
    // 删除只包含时间、回执或图标的独立子节点。
    [...clone.querySelectorAll('*')].reverse().forEach((node) => {
      const nodeText = node.textContent || '';
      if (!isOnlyMessageMetadata(nodeText)) return;
      rememberClocks(node);
      node.remove();
    });

    let text = cleanText(removeDomIconNoise(clone.textContent || ''));
    text = stripRepeatedTrailingClockMetadata(text);
    text = stripTrailingClockAlreadyRemovedElsewhere(text, removedClocks);
    return cleanText(text);
  }

  function shouldIgnoreText(text) {
    if (!text) return true;
    if (text.length > MAX_MESSAGE_LENGTH) return true;
    if (/^(https?:\/\/\S+|www\.\S+)$/i.test(text)) return true;
    if (!/[\p{L}\p{N}]/u.test(text)) return true;
    return false;
  }

  function getMessageUi(textElement) {
    let ui = messageUi.get(textElement);
    if (ui?.isConnected) return ui;

    ui = document.createElement('div');
    ui.className = 'xdmt-message-ui';
    ui.dataset.xdmtUi = 'true';
    ui.dataset.xdmtStatus = 'loading';

    const parent = textElement.parentElement;
    if (parent) parent.append(ui);
    else textElement.insertAdjacentElement('afterend', ui);

    messageUi.set(textElement, ui);
    return ui;
  }

  function renderLoading(ui, text) {
    ui.dataset.xdmtStatus = 'loading';
    ui.replaceChildren();
    const line = document.createElement('div');
    line.className = 'xdmt-text';
    line.textContent = text;
    ui.append(line);
  }

  function renderTranslation(ui, translation, source, confidence) {
    ui.dataset.xdmtStatus = 'done';
    ui.replaceChildren();

    const meta = document.createElement('div');
    meta.className = 'xdmt-meta';
    meta.textContent = `${languageName(source)} → 中文 · 识别置信度 ${Math.round(confidence * 100)}%`;

    const text = document.createElement('div');
    text.className = 'xdmt-text';
    text.textContent = translation;

    ui.append(meta, text);
  }

  function renderError(ui, error) {
    ui.dataset.xdmtStatus = 'error';
    ui.replaceChildren();

    const text = document.createElement('div');
    text.className = 'xdmt-text';
    text.textContent = readableError(error);
    ui.append(text);
  }

  function renderDownloadButton(ui, textElement, originalText, source, target, confidence, signature) {
    ui.dataset.xdmtStatus = 'waiting';
    ui.replaceChildren();

    const meta = document.createElement('div');
    meta.className = 'xdmt-meta';
    meta.textContent = `${languageName(source)} → ${languageName(target)} 模型尚未在本扩展中启用`;

    const actions = document.createElement('div');
    actions.className = 'xdmt-message-actions';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '下载模型并翻译';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '正在下载…';

      // 已知语言组合，因此在第一次 await 前直接调用 create()。
      const creation = startTranslatorCreation(source, target, (percent) => {
        button.textContent = percent === null ? '正在下载…' : `正在下载 ${percent}%`;
      });

      try {
        const session = await creation;
        if (messageState.get(textElement)?.signature !== signature) return;
        renderLoading(ui, '正在翻译…');
        const translated = await enqueueTask(() => translateWithSession(session, originalText));
        if (messageState.get(textElement)?.signature !== signature) return;
        renderTranslation(ui, translated, source, confidence);
        messageState.set(textElement, { signature, status: 'done' });
      } catch (error) {
        renderError(ui, error);
        messageState.set(textElement, { signature, status: 'error' });
      }
    });

    actions.append(button);
    ui.append(meta, actions);
  }

  function renderLanguageChoice(ui, textElement, originalText, detected, signature) {
    ui.dataset.xdmtStatus = 'waiting';
    ui.replaceChildren();

    const meta = document.createElement('div');
    meta.className = 'xdmt-meta';
    meta.textContent = `语言识别置信度较低（${Math.round(detected.confidence * 100)}%），请选择原文语言`;

    const actions = document.createElement('div');
    actions.className = 'xdmt-message-actions';

    const select = document.createElement('select');
    const choices = [...new Set([
      detected.source,
      'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'it', 'ar', 'th', 'vi', 'id', 'tr'
    ])].filter((code) => code && code !== 'und' && !isChinese(code));

    for (const code of choices) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = languageName(code);
      select.append(option);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '按所选语言翻译';
    button.addEventListener('click', async () => {
      const source = select.value;
      button.disabled = true;
      select.disabled = true;

      // 语言由用户选定，可在点击事件中直接创建对应模型。
      const creation = startTranslatorCreation(source, INCOMING_TARGET, (percent) => {
        button.textContent = percent === null ? '正在下载…' : `正在下载 ${percent}%`;
      });

      try {
        const session = await creation;
        renderLoading(ui, '正在翻译…');
        const translated = await enqueueTask(() => translateWithSession(session, originalText));
        if (messageState.get(textElement)?.signature !== signature) return;
        renderTranslation(ui, translated, source, detected.confidence);
        messageState.set(textElement, { signature, status: 'done' });
      } catch (error) {
        renderError(ui, error);
        messageState.set(textElement, { signature, status: 'error' });
      }
    });

    actions.append(select, button);
    ui.append(meta, actions);
  }

  async function processMessage(textElement) {
    if (!textElement?.isConnected) return;

    const originalText = extractMessageText(textElement);
    if (shouldIgnoreText(originalText)) return;

    const signature = `${INCOMING_TARGET}\u0000${originalText}`;
    const previous = messageState.get(textElement);
    if (previous?.signature === signature) return;

    messageState.set(textElement, { signature, status: 'processing' });
    const ui = getMessageUi(textElement);
    renderLoading(ui, '正在识别语言…');

    try {
      const detected = await detectLanguage(originalText);
      if (messageState.get(textElement)?.signature !== signature) return;

      if (isChinese(detected.source)) {
        ui.remove();
        messageUi.delete(textElement);
        messageState.set(textElement, { signature, status: 'ignored' });
        return;
      }

      if (detected.source === 'und' || detected.confidence < settings.minConfidence) {
        renderLanguageChoice(ui, textElement, originalText, detected, signature);
        messageState.set(textElement, { signature, status: 'waiting' });
        return;
      }

      renderLoading(ui, `正在把${languageName(detected.source)}翻成中文…`);

      let session;
      try {
        session = await ensureTranslatorAutomatically(detected.source, INCOMING_TARGET);
      } catch (error) {
        if (error.code === 'TRANSLATOR_DOWNLOAD_REQUIRED') {
          renderDownloadButton(
            ui,
            textElement,
            originalText,
            detected.source,
            INCOMING_TARGET,
            detected.confidence,
            signature
          );
          messageState.set(textElement, { signature, status: 'waiting' });
          return;
        }
        throw error;
      }

      const translated = await enqueueTask(() => translateWithSession(session, originalText));
      if (messageState.get(textElement)?.signature !== signature) return;

      renderTranslation(ui, translated, detected.source, detected.confidence);
      messageState.set(textElement, { signature, status: 'done' });
    } catch (error) {
      if (error.code === 'DETECTOR_DOWNLOAD_REQUIRED' || error?.name === 'NotAllowedError') {
        apiState = 'needs-init';
        updateToolbar();
        ui.remove();
        messageUi.delete(textElement);
        messageState.delete(textElement);
        return;
      }

      renderError(ui, error);
      messageState.set(textElement, { signature, status: 'error' });
    }
  }

  function scheduleScan(delay = 180) {
    const dueAt = Date.now() + delay;

    // 使用“尽早执行”的节流逻辑，避免 X 页面持续变化时反复 clearTimeout，
    // 导致旧版防抖扫描一直得不到执行。
    if (scanTimer && scanDueAt <= dueAt) return;

    clearTimeout(scanTimer);
    scanDueAt = dueAt;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanDueAt = 0;
      scanMessages();
    }, delay);
  }

  function scanMessages() {
    updateToolbar();

    if (!settings.enabled || !settings.autoTranslate || !isDmPage() || apiState !== 'ready') {
      return 0;
    }

    const elements = collectMessageTextElements();
    for (const textElement of elements) {
      processMessage(textElement);
    }
    return elements.length;
  }

  function rescanLoadedMessagesByUserGesture() {
    if (apiState !== 'ready') {
      setToolbarStatus('请先完成本地翻译初始化');
      return;
    }

    resetRenderedTranslations();
    const count = scanMessages();
    if (count > 0) {
      setToolbarStatus(`已找到 ${count} 条已加载文本，正在识别`);
    } else {
      setToolbarStatus('未找到消息；请进入具体对话并向上滚动加载历史记录');
    }
  }

  function findComposer() {
    const selectors = [
      '[data-testid="dmComposerTextInput"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea'
    ];

    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    return candidates.find((element) => {
      if (element.closest('[data-xdmt-ui="true"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 80 && rect.height > 15 && rect.bottom > 0 && rect.top < window.innerHeight;
    }) || null;
  }

  function readComposerText(composer) {
    if ('value' in composer) return cleanText(composer.value);
    return cleanText(composer.innerText || composer.textContent || '');
  }

  async function translateComposerByUserGesture() {
    const toolbar = ensureToolbar();
    const composer = findComposer();
    const button = toolbar.querySelector('[data-xdmt-action="composer"]');

    if (!composer) {
      setToolbarStatus('没有找到 X 私信输入框');
      return;
    }

    const originalText = readComposerText(composer);
    if (!originalText) {
      setToolbarStatus('请先在 X 输入框中输入中文');
      return;
    }

    button.disabled = true;
    button.textContent = '正在翻译…';

    // 原文语言和目标语言已知，直接在点击事件中创建模型。
    const creation = startTranslatorCreation(OUTGOING_SOURCE, settings.outgoingTarget, (percent) => {
      setToolbarStatus(percent === null ? '正在下载发送语言模型' : `正在下载发送语言模型 ${percent}%`);
    });

    try {
      const session = await creation;
      const translated = await enqueueTask(() => translateWithSession(session, originalText));
      const preview = toolbar.querySelector('.xdmt-preview');
      preview.querySelector('textarea').value = translated;
      preview.dataset.composerFound = 'true';
      preview.hidden = false;
      setToolbarStatus('翻译完成，请检查后替换');
    } catch (error) {
      setToolbarStatus(readableError(error));
    } finally {
      button.disabled = apiState !== 'ready';
      button.textContent = `翻译输入框：中文 → ${languageName(settings.outgoingTarget)}`;
    }
  }


  async function copyPreviewText() {
    const toolbar = ensureToolbar();
    const translated = toolbar.querySelector('.xdmt-preview textarea').value.trim();
    if (!translated) {
      setToolbarStatus('预览内容为空');
      return;
    }

    try {
      await navigator.clipboard.writeText(translated);
      setToolbarStatus('译文已复制');
    } catch {
      const textarea = toolbar.querySelector('.xdmt-preview textarea');
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      setToolbarStatus(copied ? '译文已复制' : '复制失败，请手动选择译文');
    }
  }

  function replaceComposerFromPreview() {
    const toolbar = ensureToolbar();
    const preview = toolbar.querySelector('.xdmt-preview');
    const translated = preview.querySelector('textarea').value.trim();
    const composer = findComposer();

    if (!composer) {
      setToolbarStatus('输入框已消失，请重新打开对话');
      return;
    }
    if (!translated) {
      setToolbarStatus('预览内容为空');
      return;
    }

    replaceComposerText(composer, translated);
    preview.hidden = true;
    setToolbarStatus('已替换输入框；请自行点击发送');
  }

  function replaceComposerText(composer, text) {
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
    }

    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function readableError(error) {
    if (!error) return '发生未知错误';
    if (error.code === 'PAIR_UNAVAILABLE') return error.message;
    if (error.code === 'API_UNAVAILABLE') return '请将 Microsoft Edge 更新到 148 或更高版本';
    if (error.name === 'NotAllowedError') return '请再次点击按钮以授权下载本地模型';
    if (error.name === 'QuotaExceededError') return '文本过长或超过本地模型处理限制';
    if (error.name === 'AbortError') return '模型加载或翻译已中止';
    return error.message || String(error);
  }

  async function loadSettings() {
    settings = await chrome.storage.sync.get(DEFAULTS);
  }

  function resetRenderedTranslations() {
    document.querySelectorAll('.xdmt-message-ui').forEach((element) => element.remove());
    messageState = new WeakMap();
    messageUi = new WeakMap();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;

    const oldOutgoingTarget = settings.outgoingTarget;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }

    if (!settings.enabled) {
      resetRenderedTranslations();
    } else if (oldOutgoingTarget !== settings.outgoingTarget || changes.minConfidence) {
      resetRenderedTranslations();
    }

    updateToolbar();
    scheduleScan(0);
  });

  const observer = new MutationObserver((mutations) => {
    if (location.pathname !== previousPath) {
      previousPath = location.pathname;
      updateToolbar();
      scheduleScan(0);
      return;
    }

    // 忽略扩展自身工具栏和译文区域造成的 DOM 变化，避免扫描自循环。
    const hasRelevantPageChange = mutations.some((mutation) => {
      const target = mutation.target.nodeType === Node.TEXT_NODE
        ? mutation.target.parentElement
        : mutation.target;
      return !target?.closest?.('[data-xdmt-ui="true"]');
    });

    if (hasRelevantPageChange) scheduleScan();
  });

  async function main() {
    await loadSettings();
    ensureToolbar();
    updateToolbar();

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // X 使用虚拟消息列表。向上滚动时，旧消息节点可能被复用或替换。
    document.addEventListener('scroll', () => scheduleScan(60), true);
    window.addEventListener('focus', () => scheduleScan(0));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleScan(0);
    });

    // 定时兜底：即使页面只修改了内部状态而没有生成可观察的 childList 变化，
    // 也会再次发现已加载的历史消息。WeakMap 会阻止重复翻译。
    setInterval(() => {
      if (!document.hidden && isDmPage()) scheduleScan(0);
    }, 1500);

    await bootstrapApi();
    scheduleScan(0);
  }

  main().catch((error) => {
    apiState = 'error';
    updateToolbar();
    setToolbarStatus(readableError(error));
  });
})();
