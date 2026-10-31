(() => {
  'use strict';
  const root = document.documentElement;
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'dark' || theme === 'light') root.classList.add(theme);
  const data = window.VNBOT_FEATURES;
  const windows = data.downloads.windows;
  const en = root.lang === 'en';
  const labels = {
    vi: { windowsDownload: 'Tải cho Windows' },
    en: { windowsDownload: 'Download for Windows' },
  };
  document.querySelectorAll('.btn-win .lbl').forEach(label => {
    label.firstChild.textContent = labels[en ? 'en' : 'vi'].windowsDownload;
  });
  const downloads = { windows, msi: windows.msi };
  document.querySelectorAll('[data-size]').forEach(el => {
    el.textContent = data.sizeMB(downloads[el.dataset.size]);
  });
  document.querySelectorAll('[data-version]').forEach(el => { el.textContent = windows.version; });
  document.querySelectorAll('[data-sha]').forEach(el => {
    const sha = downloads[el.dataset.sha].sha256;
    el.title = sha;
    el.dataset.fullSha = sha;
    el.textContent = el.hasAttribute('data-short') ? `${sha.slice(0, 8)}…${sha.slice(-6)}` : sha;
  });
  document.querySelectorAll('.copy').forEach(button => {
    let reset;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(windows.sha256);
        clearTimeout(reset);
        button.textContent = en ? 'Copied' : 'Đã chép';
        button.classList.add('copied');
        reset = setTimeout(() => {
          button.textContent = en ? 'Copy' : 'Sao chép';
          button.classList.remove('copied');
        }, 2000);
      } catch {
        button.textContent = en ? 'Could not copy' : 'Chưa chép được';
      }
    });
  });
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const reveal = el => { el.dataset.revealed = 'true'; };
  const targets = document.querySelectorAll('[data-reveal]');
  // Reveal large containers through a small sentinel so the threshold remains reachable on phones.
  if ('IntersectionObserver' in window && !motion.matches) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          reveal(entry.target.parentElement);
          observer.unobserve(entry.target);
          entry.target.remove();
        }
      });
    }, { threshold: .25 });
    targets.forEach(el => {
      const marker = document.createElement('span');
      marker.className = 'reveal-marker';
      marker.setAttribute('aria-hidden', 'true');
      el.prepend(marker);
      observer.observe(marker);
    });
    root.classList.add('js');
    motion.addEventListener('change', () => {
      if (motion.matches) {
        observer.disconnect();
        targets.forEach(reveal);
      }
    });
  } else targets.forEach(reveal);
  requestAnimationFrame(() => document.querySelector('.hero')?.classList.add('go'));
  const non = document.querySelector('[data-blink]');
  if (non) {
    const bounce = non.src;
    const base = new URL(non.dataset.blinkPose || 'base.png', bounce).href;
    const source = non.parentElement.querySelector('source[type="image/webp"]');
    const swap = (src) => {
      source.srcset = src.replace(/\.png$/, '.webp');
      non.src = src;
    };
    const pose = document.createElement('picture');
    const poseSource = document.createElement('source');
    const poseImage = new Image();
    poseSource.type = 'image/webp';
    poseSource.srcset = base.replace(/\.png$/, '.webp');
    pose.append(poseSource, poseImage);
    let timer;
    poseImage.src = base;
    const schedule = () => {
      clearTimeout(timer);
      if (motion.matches) return;
      timer = setTimeout(() => {
        if (!motion.matches && poseImage.complete && poseImage.naturalWidth) {
          swap(base);
          setTimeout(() => { swap(bounce); }, 160);
        }
        schedule();
      }, 4000 + Math.random() * 2000);
    };
    schedule();
    motion.addEventListener('change', schedule);
  }
})();
