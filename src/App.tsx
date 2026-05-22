import { useState, useEffect, useCallback, useRef } from 'react';
import * as faceapi from '@vladmandic/face-api';
import {
  Lock, Eye, EyeOff, Plus, Trash2, FolderOpen, Link2,
  Grid3X3, LayoutGrid,
  X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut, RotateCw,
  LogOut, AlertCircle, Search, Images, ShieldCheck, Upload,
  RefreshCw, Settings, KeyRound, Save, ExternalLink, Shield,
  Layers, Camera, Sparkles, ImageIcon, ScanFace, UploadCloud,
  Heart, FileDown, FileUp
} from 'lucide-react';

/* ═══════════════════ TYPES ═══════════════════ */
interface GDriveFolder { id: string; name: string; folderId: string; link: string; }
interface Photo { id: string; fileId: string; name: string; thumb: string; full: string; dl: string; folder: string; folderId: string; createdTime?: string; }
type SortMode = 'date-new' | 'date-old' | 'name-az' | 'name-za' | 'folder-az' | 'folder-za';
type AppMode = 'gallery-login' | 'face-capture' | 'gallery' | 'admin-login' | 'admin';

/* ═══════════════════ STORAGE ═══════════════════ */
const GALLERY_PW_KEY = 'gal_pw';
const ADMIN_PW_KEY = 'gal_admin_pw';
const FOLDERS_KEY = 'gal_folders';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/model';
const CONFIG_FILE = 'config.enc.json';
const ENC_SALT = 'photogallery_v1_salt_2024';

/* ═══════════════ ENCRYPTION HELPERS ═══════════════
   We use AES-GCM with a key derived from a fixed passphrase.
   The "encryption" here protects against casual snooping —
   passwords inside are already SHA-256 hashed, folder IDs are
   public anyway. The key is embedded in the app so a determined
   person could decrypt, but it stops plaintext exposure.
   ═══════════════════════════════════════════════════ */
async function getEncKey(): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(ENC_SALT);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptData(data: string): Promise<string> {
  const key = await getEncKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(data));
  const buf = new Uint8Array(iv.length + enc.byteLength);
  buf.set(iv); buf.set(new Uint8Array(enc), iv.length);
  return btoa(String.fromCharCode(...buf));
}

async function decryptData(b64: string): Promise<string> {
  const key = await getEncKey();
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = buf.slice(0, 12);
  const data = buf.slice(12);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(dec);
}

interface ConfigData {
  galPwHash: string;
  adminPwHash: string;
  folders: GDriveFolder[];
  apiKey?: string;
}

/* ═══════════════ CONFIG LOADING ═══════════════
   Priority: 1) config.enc.json file  2) localStorage
   ═══════════════════════════════════════════════ */
let FILE_CONFIG: ConfigData | null = null;
let configLoaded = false;

async function loadConfigFile(): Promise<ConfigData | null> {
  if (configLoaded) return FILE_CONFIG;
  configLoaded = true;
  try {
    const res = await fetch(CONFIG_FILE);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.trim() === '{}' || text.trim().length < 20) return null;
    const json = JSON.parse(text);
    if (!json.data || typeof json.data !== 'string') return null;
    const decrypted = await decryptData(json.data);
    FILE_CONFIG = JSON.parse(decrypted) as ConfigData;
    console.log('Config file loaded successfully');
    return FILE_CONFIG;
  } catch {
    return null;
  }
}

function getGalPwHash() { return FILE_CONFIG?.galPwHash || localStorage.getItem(GALLERY_PW_KEY) || ''; }
function getAdminPwHash() { return FILE_CONFIG?.adminPwHash || localStorage.getItem(ADMIN_PW_KEY) || ''; }

/* ═══════════════════ HELPERS ═══════════════════ */
async function sha256(t: string) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); }
function extractFolderId(url: string): string | null { const m1 = url.match(/\/folders\/([a-zA-Z0-9_-]+)/); if (m1) return m1[1]; const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/); if (m2) return m2[1]; if (/^[a-zA-Z0-9_-]{15,}$/.test(url.trim())) return url.trim(); return null; }
function makeThumb(fid: string) { return `https://lh3.googleusercontent.com/d/${fid}=w400`; }
function makeFull(fid: string) { return `https://lh3.googleusercontent.com/d/${fid}=w1920`; }
function makeDl(fid: string) { return `https://drive.google.com/uc?export=view&id=${fid}`; }

const API_KEY_STORAGE = 'gal_api_key';
function getApiKey(): string { return FILE_CONFIG?.apiKey || localStorage.getItem(API_KEY_STORAGE) || ''; }

interface FileInfo { id: string; createdTime?: string; }

/**
 * List ALL files in a single folder with pagination.
 */
async function listFolder(folderId: string, apiKey: string): Promise<{ images: FileInfo[]; subfolders: string[] }> {
  const images: FileInfo[] = [];
  const subfolders: string[] = [];
  let pageToken = '';

  do {
    const url = `https://www.googleapis.com/drive/v3/files?` +
      `q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}` +
      `&key=${encodeURIComponent(apiKey)}` +
      `&fields=${encodeURIComponent('nextPageToken,files(id,mimeType,createdTime)')}` +
      `&pageSize=1000` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.error(`API error for folder ${folderId}:`, data.error.message);
      throw new Error(data.error.message);
    }

    for (const f of (data.files || [])) {
      if (f.mimeType?.startsWith('image/')) {
        images.push({ id: f.id, createdTime: f.createdTime || '' });
      } else if (f.mimeType === 'application/vnd.google-apps.folder') {
        subfolders.push(f.id);
      }
    }

    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return { images, subfolders };
}

/**
 * Fetch ALL images from a folder tree — recursively scans subfolders.
 */
async function fetchViaApi(rootFolderId: string, apiKey: string): Promise<FileInfo[]> {
  const allImages = new Map<string, FileInfo>();
  const visited = new Set<string>();
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const fid = queue.shift()!;
    if (visited.has(fid)) continue;
    visited.add(fid);

    try {
      const { images, subfolders } = await listFolder(fid, apiKey);
      for (const img of images) allImages.set(img.id, img);
      for (const sf of subfolders) {
        if (!visited.has(sf)) queue.push(sf);
      }
      console.log(`  Folder ${fid}: ${images.length} images, ${subfolders.length} subfolders`);
    } catch (e) {
      console.error(`  Folder ${fid} failed:`, e);
    }
  }

  console.log(`Total: ${allImages.size} images across ${visited.size} folder(s) from root ${rootFolderId}`);
  return Array.from(allImages.values());
}

/** Fallback: scrape HTML page via CORS proxy (limited to ~50-100 files) */
async function fetchViaScrape(folderId: string): Promise<string[]> {
  const ids = new Set<string>();
  const driveUrl = `https://drive.google.com/drive/folders/${folderId}`;
  const proxies = [
    (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];
  let html = '';
  for (const proxy of proxies) {
    try {
      const res = await fetch(proxy(driveUrl));
      if (res.ok) { html = await res.text(); if (html.length > 500) break; }
    } catch { continue; }
  }
  if (!html) throw new Error('Could not fetch folder');
  let m;
  const r1 = /data-id="([a-zA-Z0-9_-]{20,})"/g; while ((m = r1.exec(html))) ids.add(m[1]);
  const r2 = /\/file\/d\/([a-zA-Z0-9_-]{20,})/g; while ((m = r2.exec(html))) ids.add(m[1]);
  const r3 = /\["([a-zA-Z0-9_-]{20,})"[^\]]*?"image\/(jpeg|png|gif|webp|bmp|svg\+xml|heic|heif|tiff)"/g; while ((m = r3.exec(html))) ids.add(m[1]);
  const r4 = /[,\[]\s*"([a-zA-Z0-9_-]{25,45})"\s*[,\]]/g;
  while ((m = r4.exec(html))) {
    const c = m[1];
    if (c !== folderId && /[a-z]/.test(c) && /[0-9A-Z]/.test(c) && !c.includes('__') && !/^[a-z]+$/.test(c) && !/^[A-Z_]+$/.test(c)) ids.add(c);
  }
  ids.delete(folderId);
  return Array.from(ids);
}

let _lastApiStatus = '';
function getLastApiStatus() { return _lastApiStatus; }

async function fetchFolderFileIds(folderId: string): Promise<FileInfo[]> {
  const apiKey = getApiKey();
  if (apiKey) {
    _lastApiStatus = 'using-api';
    try {
      const result = await fetchViaApi(folderId, apiKey);
      _lastApiStatus = `api-ok:${result.length}`;
      console.log(`fetchFolderFileIds(${folderId}): API returned ${result.length} images`);
      if (result.length > 0) return result;
      _lastApiStatus = 'api-returned-0';
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      _lastApiStatus = `api-error:${msg}`;
      console.error('API FAILED for', folderId, ':', msg);
    }
  } else {
    _lastApiStatus = 'no-api-key';
  }

  console.log(`Falling back to scrape for folder ${folderId}`);
  try {
    const scrapeResult = await fetchViaScrape(folderId);
    _lastApiStatus += `|scrape:${scrapeResult.length}`;
    // Scrape doesn't have dates — return as FileInfo without createdTime
    return scrapeResult.map(id => ({ id }));
  } catch (e) {
    console.error('Scrape also failed for', folderId, e);
    _lastApiStatus += '|scrape-failed';
    return [];
  }
}

function loadFolders(): GDriveFolder[] { if (FILE_CONFIG?.folders?.length) return FILE_CONFIG.folders; try { return JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]'); } catch { return []; } }
function saveFolders(f: GDriveFolder[]) { localStorage.setItem(FOLDERS_KEY, JSON.stringify(f)); }
function loadImage(src: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error('Failed')); img.src = src; }); }

/* ═══════════════ BG PARTICLES ═══════════════ */
function BgParticles() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      <div className="absolute -top-20 -left-20 w-[500px] h-[500px] rounded-full bg-amber-700/[0.06] blur-[150px] grad-move" />
      <div className="absolute -bottom-20 -right-20 w-[400px] h-[400px] rounded-full bg-rose-900/[0.05] blur-[130px] grad-move" style={{ animationDelay: '3s' }} />
      <div className="absolute top-1/3 right-1/4 w-[300px] h-[300px] rounded-full bg-orange-800/[0.04] blur-[120px] grad-move" style={{ animationDelay: '5s' }} />
      {/* Gold sparkle particles */}
      {Array.from({ length: 25 }).map((_, i) => (<div key={i} className="absolute rounded-full" style={{ width: `${1.5 + Math.random() * 3}px`, height: `${1.5 + Math.random() * 3}px`, top: `${Math.random() * 100}%`, left: `${Math.random() * 100}%`, background: i % 3 === 0 ? 'rgba(212,168,83,0.08)' : 'rgba(255,255,255,0.025)', animation: `float ${4 + Math.random() * 6}s ease-in-out infinite`, animationDelay: `${Math.random() * 5}s` }} />))}
    </div>
  );
}

/* ═══════════════ LOADER ═══════════════ */
const LOADING_TIPS = ["Loading your precious moments…", "Unwrapping the wedding memories…", "Gathering all the beautiful shots…", "Almost there, hang tight…", "Preparing your memories…", "Every love story is beautiful…", "Bringing your moments to life…", "Just a moment, something special is loading…", "Collecting all the magical captures…", "Your wedding memories await…"];
const _SCAN_TIPS = ["AI is finding your moments…", "Scanning wedding photos for you…", "Matching your face across all shots…", "Looking for you in the celebrations…", "AI magic in progress…", "Searching through the memories…", "Finding your best moments…", "Almost done, just a bit more…"];
function useCyclingTip(tips: string[], interval = 3000) { const [i, setI] = useState(0); useEffect(() => { const t = setInterval(() => setI(n => (n + 1) % tips.length), interval); return () => clearInterval(t); }, [tips, interval]); return tips[i]; }

function FancyLoader({ tips, progress, total, label }: { tips: string[]; progress: number; total: number; label: string }) {
  const [tipIdx, setTipIdx] = useState(0);
  useEffect(() => { const t = setInterval(() => setTipIdx(i => (i + 1) % tips.length), 3200); return () => clearInterval(t); }, [tips]);
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  return (
    <div className="fixed inset-0 z-40 bg-dark-950 flex items-center justify-center">
      <div className="absolute inset-0 bg-cover bg-center opacity-30" style={{ backgroundImage: 'url(/images/wedding-bg.jpg)' }} />
      <div className="absolute inset-0 bg-dark-950/60" />
      <BgParticles />
      <div className="relative flex flex-col items-center anim-scale-in z-10">
        <div className="relative w-40 h-40 mb-10">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="absolute w-32 h-32 rounded-full border border-amber-500/10 spin-slow" />
            <div className="absolute w-24 h-24 rounded-full border border-rose-500/8 spin-slow" style={{ animationDirection: 'reverse', animationDuration: '8s' }} />
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-600 via-yellow-700 to-orange-700 flex items-center justify-center shadow-2xl shadow-amber-700/30 anim-float anim-glow">
              <Heart className="w-10 h-10 text-white drop-shadow-lg" />
            </div>
          </div>
          <div className="absolute inset-0 flex items-center justify-center"><div className="anim-orbit" style={{ animationDuration: '3.5s' }}><div className="w-9 h-9 rounded-xl bg-rose-500/15 backdrop-blur border border-rose-500/15 flex items-center justify-center shadow-lg"><ImageIcon className="w-4 h-4 text-rose-300" /></div></div></div>
          <div className="absolute inset-0 flex items-center justify-center"><div className="anim-orbit" style={{ animationDuration: '5s', animationDelay: '-1.5s' }}><div className="w-9 h-9 rounded-xl bg-amber-500/15 backdrop-blur border border-amber-500/15 flex items-center justify-center shadow-lg"><Sparkles className="w-4 h-4 text-amber-300" /></div></div></div>
          <div className="absolute inset-0 flex items-center justify-center"><div className="anim-orbit" style={{ animationDuration: '6.5s', animationDelay: '-3s' }}><div className="w-9 h-9 rounded-xl bg-orange-500/15 backdrop-blur border border-orange-500/15 flex items-center justify-center shadow-lg"><Camera className="w-4 h-4 text-orange-300" /></div></div></div>
        </div>
        <div className="w-64 mb-6">
          <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-amber-500 via-rose-400 to-amber-500 rounded-full transition-all duration-700 ease-out grad-move" style={{ width: `${Math.max(pct, 10)}%` }} /></div>
          {total > 0 && <p className="text-amber-200/25 text-[10px] text-center mt-2 font-light tabular-nums">{progress} / {total} {label}</p>}
        </div>
        <div className="h-7 relative w-80 overflow-hidden">{tips.map((tip, i) => (<p key={i} className="absolute inset-0 flex items-center justify-center text-amber-100/35 text-[13px] text-center transition-all duration-500 font-light italic" style={{ opacity: i === tipIdx ? 1 : 0, transform: i === tipIdx ? 'translateY(0)' : 'translateY(14px)' }}>{tip}</p>))}</div>
        <div className="flex gap-2.5 mt-6">{[0, 1, 2].map(i => (<div key={i} className="w-1.5 h-1.5 rounded-full bg-amber-400" style={{ animation: 'pulse3 1.4s ease-in-out infinite', animationDelay: `${i * 0.3}s` }} />))}</div>
      </div>
    </div>
  );
}

/* ═══════════════ FACE CAPTURE ═══════════════ */
function FaceCapture({ onCapture, onSkip, onClose }: { onCapture: (d: Float32Array) => void; onSkip: () => void; onClose?: () => void }) {
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelLoading, setModelLoading] = useState(true);
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [useCamera, setUseCamera] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const selfieRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Load AI models — SSD MobileNet (accurate) + TinyFaceDetector (fast) + landmarks + recognition
  useEffect(() => {
    (async () => {
      try {
        setModelLoading(true);
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        setModelsLoaded(true);
      } catch (e) {
        console.error(e);
        setError('Failed to load AI models. Please refresh.');
      }
      setModelLoading(false);
    })();
  }, []);

  // Start camera (desktop only — mobile uses native capture)
  const startCamera = async () => {
    if (isMobile) {
      // On mobile, trigger native camera via file input with capture attribute
      selfieRef.current?.click();
      return;
    }
    setError('');
    try {
      // Use flexible constraints for compatibility
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        // Wait for video to actually be playing before allowing capture
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().then(() => setCameraReady(true)).catch(() => {});
        };
      }
      setUseCamera(true);
      setPreviewUrl(null);
      setCameraReady(false);
    } catch (e) {
      console.error('Camera error:', e);
      setError('Camera unavailable. Use "Upload" or try on mobile.');
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setUseCamera(false);
    setCameraReady(false);
  };

  const captureFromCamera = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    setPreviewUrl(c.toDataURL('image/jpeg', 0.9));
    stopCamera();
  };

  // Handle file from camera capture (mobile) or gallery upload
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so same file can be re-selected
    e.target.value = '';
    setPreviewUrl(URL.createObjectURL(file));
    setUseCamera(false);
    stopCamera();
    setError('');
  };

  const detectFace = async () => {
    if (!previewUrl || !modelsLoaded) return;
    setProcessing(true);
    setError('');
    try {
      const img = await loadImage(previewUrl);

      // Use SSD MobileNet v1 — most accurate detector for the reference selfie
      const detection = await faceapi
        .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        // Fallback to TinyFaceDetector
        const fallback = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.2 }))
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (!fallback) {
          setError('No face detected. Make sure your face is clearly visible and well-lit.');
          setProcessing(false);
          return;
        }
        onCapture(fallback.descriptor);
      } else {
        onCapture(detection.descriptor);
      }
    } catch (e) {
      console.error('Face detect error:', e);
      setError('Detection failed. Try a different photo.');
    }
    setProcessing(false);
  };

  useEffect(() => () => stopCamera(), []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-cover bg-center opacity-20" style={{ backgroundImage: 'url(/images/face-bg.jpg)' }} />
      <div className="absolute inset-0 bg-black/85" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-dark-950/90 to-black/95" />
      <BgParticles />
      <div className="relative z-10 w-full max-w-lg"><div className="glass-card rounded-[32px] p-8 shadow-2xl shadow-black/60 anim-scale-in border border-white/[0.05]">
        {/* Top bar */}
        <div className="flex items-center justify-end mb-2">
          {onClose && (
            <button onClick={onClose}
              className="p-2 rounded-xl text-white/25 hover:text-white/60 hover:bg-white/[0.04] transition-all">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        {/* Header */}
        <div className="flex flex-col items-center mb-7">
          <div className="relative mb-4">
            <div className="w-20 h-20 rounded-[22px] bg-gradient-to-br from-rose-500 via-pink-500 to-amber-500 flex items-center justify-center shadow-xl shadow-rose-600/25 anim-glow">
              <ScanFace className="w-10 h-10 text-white drop-shadow" />
            </div>
            <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-gradient-to-br from-amber-400 to-yellow-500 flex items-center justify-center shadow-md animate-pulse">
              <Sparkles className="w-3 h-3 text-white" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gradient tracking-tight">Find Your Moments</h1>
            <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[9px] font-bold uppercase tracking-wider border border-rose-500/20">AI</span>
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[9px] font-bold uppercase tracking-wider border border-amber-500/20">Beta</span>
          </div>
          <p className="text-amber-100/30 text-sm mt-2 text-center max-w-xs leading-relaxed font-light italic">
            {isMobile ? 'Take a selfie or pick from gallery — we\'ll find all your wedding photos' : 'Upload your photo — AI will find every wedding moment with you'}
          </p>
          <p className="text-amber-200/15 text-[10px] mt-2 text-center max-w-xs leading-relaxed flex items-center justify-center gap-1.5">
            <Sparkles className="w-3 h-3 text-amber-400/30" /> Powered by AI face recognition · results may vary
          </p>
        </div>

        {/* Model loading */}
        {modelLoading && (
          <div className="flex flex-col items-center py-10">
            <div className="relative w-12 h-12 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-purple-500/20" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-400 animate-spin" />
            </div>
            <p className="text-white/40 text-sm">Loading AI face recognition models…</p>
            <p className="text-white/20 text-xs mt-1">Downloading neural networks — first visit may take a moment</p>
          </div>
        )}

        {/* Main content */}
        {!modelLoading && (
          <div className="space-y-4">
            {/* Preview area */}
            <div className="relative aspect-[4/3] bg-dark-700/50 rounded-2xl overflow-hidden border border-white/[0.06] shadow-inner">
              {/* Live camera feed (desktop) */}
              {useCamera && (
                <video ref={videoRef} autoPlay playsInline muted
                  className="w-full h-full object-cover"
                  style={{ transform: 'scaleX(-1)' }} />
              )}
              {/* Preview of captured/uploaded image */}
              {previewUrl && !useCamera && (
                <img src={previewUrl} alt="Your face" className="w-full h-full object-cover" />
              )}
              {/* Empty state */}
              {!useCamera && !previewUrl && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white/15 gap-3">
                  <div className="w-20 h-20 rounded-2xl border-2 border-dashed border-white/10 flex items-center justify-center">
                    <ScanFace className="w-10 h-10" />
                  </div>
                  <p className="text-sm font-light">Your photo appears here</p>
                </div>
              )}
              {/* Camera shutter button */}
              {useCamera && cameraReady && (
                <button onClick={captureFromCamera}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full bg-white/90 hover:bg-white border-[5px] border-white/30 flex items-center justify-center shadow-2xl transition-all active:scale-90 hover:scale-105">
                  <div className="w-11 h-11 rounded-full bg-gradient-to-br from-red-500 to-rose-600" />
                </button>
              )}
              {/* Camera loading indicator */}
              {useCamera && !cameraReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                </div>
              )}
              {/* Clear button on preview */}
              {previewUrl && !useCamera && (
                <button onClick={() => { setPreviewUrl(null); setError(''); }}
                  className="absolute top-3 right-3 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white/60 hover:text-white transition backdrop-blur">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Action buttons */}
            <div className="grid grid-cols-2 gap-3">
              {/* Take Selfie — on mobile uses native camera, on desktop uses getUserMedia */}
              <button onClick={startCamera} disabled={useCamera || !modelsLoaded}
                className="py-3.5 glass rounded-2xl text-white text-sm font-medium transition-all hover:bg-white/[0.08] flex items-center justify-center gap-2 disabled:opacity-30 group">
                <Camera className="w-5 h-5 text-rose-400 group-hover:scale-110 transition-transform" /> Take Selfie
              </button>
              {/* Upload from gallery */}
              <button onClick={() => uploadRef.current?.click()} disabled={!modelsLoaded}
                className="py-3.5 glass rounded-2xl text-white text-sm font-medium transition-all hover:bg-white/[0.08] flex items-center justify-center gap-2 disabled:opacity-30 group">
                <UploadCloud className="w-5 h-5 text-amber-400 group-hover:scale-110 transition-transform" /> Upload
              </button>
              {/* Hidden file inputs */}
              {/* Mobile selfie — uses capture="user" to open front camera natively */}
              <input ref={selfieRef} type="file" accept="image/*" capture="user" className="hidden" onChange={handleFile} />
              {/* Gallery upload — no capture attribute, opens file picker */}
              <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            </div>

            {/* Error */}
            {error && (
              <p className="text-red-400 text-xs flex items-center gap-2 bg-red-500/10 border border-red-500/15 rounded-xl px-4 py-3">
                <AlertCircle className="w-4 h-4 shrink-0" />{error}
              </p>
            )}

            {/* Find My Photos button */}
            {previewUrl && (
              <button onClick={detectFace} disabled={processing || !modelsLoaded}
                className="w-full py-4 rounded-2xl font-semibold text-[15px] text-white bg-gradient-to-r from-rose-600 via-pink-600 to-amber-600 hover:from-rose-500 hover:via-pink-500 hover:to-amber-500 shadow-xl shadow-rose-600/20 transition-all active:scale-[.97] disabled:opacity-50 flex items-center justify-center gap-2.5 btn-shine grad-move">
                {processing
                  ? <><span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />AI Finding You…</>
                  : <><Sparkles className="w-5 h-5" />Find My Wedding Photos</>
                }
              </button>
            )}

            {/* Skip */}
            {/* Skip button removed intentionally — use close icon instead */}
            <div className="hidden" onClick={onSkip} />
          </div>
        )}
      </div></div>
    </div>
  );
}

/* ═══════════════ GALLERY LOGIN ═══════════════ */
function GalleryLogin({ onLogin, onAdminClick }: { onLogin: () => void; onAdminClick: () => void }) {
  const [pw, setPw] = useState(''); const [show, setShow] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const stored = getGalPwHash();
  const submit = async (e: React.FormEvent) => { e.preventDefault(); if (!stored) { setErr('Not set up yet. Contact admin.'); return; } setBusy(true); setErr(''); if (await sha256(pw) === stored) onLogin(); else setErr('Wrong password'); setBusy(false); };
  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      {/* Wedding background */}
      <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: 'url(/images/wedding-bg.jpg)' }} />
      <div className="absolute inset-0 bg-dark-950/70" />
      <BgParticles />

      <div className="relative z-10 w-full max-w-[400px] anim-scale-in">
        <form onSubmit={submit} className="glass-card rounded-[32px] p-10 shadow-2xl shadow-black/60">
          {/* Wedding icon */}
          <div className="flex flex-col items-center mb-10">
            <div className="relative mb-5">
              <div className="w-[90px] h-[90px] rounded-3xl bg-gradient-to-br from-amber-500 via-yellow-600 to-orange-600 flex items-center justify-center shadow-2xl shadow-amber-600/30 anim-glow">
                <Heart className="w-11 h-11 text-white drop-shadow-lg" />
              </div>
              <div className="absolute -bottom-2 -right-2 w-8 h-8 rounded-lg bg-gradient-to-br from-rose-400 to-pink-500 flex items-center justify-center shadow-lg shadow-rose-500/30">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
            </div>
            <h1 className="text-[28px] font-bold text-gradient tracking-tight anim-text-glow">Wedding Memories</h1>
            <p className="text-amber-100/25 text-sm mt-2 font-light italic">Enter the password to relive the moments</p>
          </div>

          {/* Form */}
          <div className="space-y-4">
            <div className="relative group">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-white/20 group-focus-within:text-amber-400 transition-colors duration-300" />
              <input autoFocus type={show ? 'text' : 'password'} value={pw} onChange={e => { setPw(e.target.value); setErr(''); }} placeholder="Password"
                className="w-full pl-12 pr-12 py-4 bg-white/[0.03] border border-amber-500/10 rounded-2xl text-white text-base placeholder-white/15 focus:outline-none input-glow focus:border-amber-500/30 transition-all duration-300" />
              <button type="button" onClick={() => setShow(!show)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/15 hover:text-white/40 transition-colors">
                {show ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
              </button>
            </div>

            {err && (
              <div className="flex items-center gap-2.5 bg-red-500/10 border border-red-500/15 rounded-2xl px-4 py-3">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <p className="text-red-400/90 text-xs">{err}</p>
              </div>
            )}

            <button type="submit" disabled={busy || !stored}
              className="w-full py-4 rounded-2xl font-semibold text-base text-white bg-gradient-to-r from-amber-600 via-yellow-600 to-amber-600 shadow-xl shadow-amber-600/20 transition-all active:scale-[.97] disabled:opacity-30 btn-shine grad-move">
              {busy ? <span className="flex items-center justify-center gap-2.5"><span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /></span> : '💍 View Wedding Album'}
            </button>
          </div>

          <button type="button" onClick={onAdminClick}
            className="mt-9 w-full text-center text-white/8 hover:text-white/25 text-[10px] transition-colors flex items-center justify-center gap-1.5">
            <Settings className="w-3 h-3" /> Admin
          </button>
        </form>

        <p className="text-center text-amber-200/[0.06] text-[10px] mt-8 flex items-center justify-center gap-1.5 font-light italic tracking-wide">
          <Heart className="w-2.5 h-2.5" /> Every love story is beautiful <Heart className="w-2.5 h-2.5" />
        </p>
      </div>
    </div>
  );
}

/* ═══════════════ ADMIN LOGIN ═══════════════ */
function AdminLogin({ onLogin, onBack }: { onLogin: () => void; onBack: () => void }) {
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [show, setShow] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const stored = getAdminPwHash(); const isNew = !stored;
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); if (isNew) { if (pw.length < 4) { setErr('Min 4 chars'); setBusy(false); return; } if (pw !== pw2) { setErr("Don't match"); setBusy(false); return; } localStorage.setItem(ADMIN_PW_KEY, await sha256(pw)); onLogin(); } else { if (await sha256(pw) === stored) onLogin(); else setErr('Wrong password'); } setBusy(false); };
  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-900 p-4 relative overflow-hidden"><BgParticles />
      <div className="relative z-10 w-full max-w-sm"><form onSubmit={submit} className="glass-strong rounded-[28px] p-8 shadow-2xl shadow-black/50 anim-scale-in">
        <div className="flex flex-col items-center mb-8"><div className="w-[76px] h-[76px] rounded-[20px] bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-xl shadow-amber-600/30 rotate-2"><Shield className="w-9 h-9 text-white" /></div><h1 className="text-xl font-bold text-white mt-4">Admin Panel</h1><p className="text-white/35 text-xs mt-0.5">{isNew ? 'Create admin password' : 'Enter admin password'}</p></div>
        <div className="space-y-3"><div className="relative"><KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-white/25" /><input autoFocus type={show ? 'text' : 'password'} value={pw} onChange={e => { setPw(e.target.value); setErr(''); }} placeholder={isNew ? 'Create password' : 'Password'} className="w-full pl-11 pr-12 py-3.5 bg-white/[0.04] border border-white/[0.08] rounded-2xl text-white text-[15px] placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition" /><button type="button" onClick={() => setShow(!show)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50 transition">{show ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}</button></div>
          {isNew && <div className="relative"><KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-white/25" /><input type={show ? 'text' : 'password'} value={pw2} onChange={e => { setPw2(e.target.value); setErr(''); }} placeholder="Confirm" className="w-full pl-11 pr-4 py-3.5 bg-white/[0.04] border border-white/[0.08] rounded-2xl text-white text-[15px] placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-amber-500/40 transition" /></div>}
          {err && <p className="text-red-400 text-xs flex items-center gap-2 bg-red-500/10 border border-red-500/15 rounded-xl px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{err}</p>}
          <button type="submit" disabled={busy} className="w-full py-3.5 rounded-2xl font-semibold text-[15px] text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 shadow-xl shadow-amber-600/20 transition-all active:scale-[.97] disabled:opacity-50">{busy ? <span className="flex items-center justify-center gap-2"><span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /></span> : isNew ? 'Create Admin' : 'Enter'}</button></div>
        <button type="button" onClick={onBack} className="mt-6 w-full text-center text-white/20 hover:text-white/50 text-xs transition">← Back</button>
      </form></div>
    </div>
  );
}

/* ═══════════════ ADMIN PANEL ═══════════════ */
function AdminPanel({ onLogout }: { onLogout: () => void }) {
  const [folders, setFolders] = useState<GDriveFolder[]>(loadFolders); const [link, setLink] = useState(''); const [name, setName] = useState(''); const [err, setErr] = useState(''); const [success, setSuccess] = useState('');
  const [galPw, setGalPw] = useState(''); const [galPw2, setGalPw2] = useState(''); const [adminPw, setAdminPw] = useState(''); const [adminPw2, setAdminPw2] = useState(''); const [pwErr, setPwErr] = useState(''); const [pwSuccess, setPwSuccess] = useState('');
  const hasGalleryPw = !!getGalPwHash();
  const [cfgMsg, setCfgMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [apiKeyInput, setApiKeyInput] = useState(getApiKey());
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [apiTestResult, setApiTestResult] = useState('');
  const [apiTesting, setApiTesting] = useState(false);
  const saveApiKey = () => { localStorage.setItem(API_KEY_STORAGE, apiKeyInput.trim()); setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000); };

  const testApiKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) { setApiTestResult('❌ Enter an API key first'); return; }
    if (!folders.length) { setApiTestResult('❌ Add a folder first to test'); return; }
    setApiTesting(true); setApiTestResult('');
    try {
      const testFolder = folders[0];
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${testFolder.folderId}' in parents and trashed=false`);
      url.searchParams.set('key', key);
      url.searchParams.set('fields', 'nextPageToken,files(id,mimeType)');
      url.searchParams.set('pageSize', '10');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try { const j = JSON.parse(body); errMsg = j.error?.message || errMsg; } catch {}
        setApiTestResult(`❌ ${errMsg}`);
      } else {
        const data = await res.json();
        if (data.error) {
          setApiTestResult(`❌ ${data.error.message}`);
        } else {
          const total = (data.files || []).length;
          const images = (data.files || []).filter((f: { mimeType: string }) => f.mimeType?.startsWith('image/')).length;
          const hasMore = data.nextPageToken ? ' (more pages available)' : '';
          setApiTestResult(`✅ Working! Found ${images} images in first ${total} files from "${testFolder.name}"${hasMore}`);
        }
      }
    } catch (e) {
      setApiTestResult(`❌ Network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setApiTesting(false);
  };

  useEffect(() => { saveFolders(folders); }, [folders]);
  const handleAdd = () => { setErr(''); setSuccess(''); const fid = extractFolderId(link.trim()); if (!fid) { setErr('Invalid link'); return; } if (folders.some(f => f.folderId === fid)) { setErr('Already added'); return; } setFolders(p => [...p, { id: crypto.randomUUID(), name: name.trim() || `Folder ${p.length + 1}`, folderId: fid, link: link.trim() }]); setLink(''); setName(''); setSuccess('Added!'); setTimeout(() => setSuccess(''), 3000); };
  const handleGalPw = async () => { setPwErr(''); setPwSuccess(''); if (galPw.length < 4) { setPwErr('Min 4 chars'); return; } if (galPw !== galPw2) { setPwErr("Don't match"); return; } localStorage.setItem(GALLERY_PW_KEY, await sha256(galPw)); setGalPw(''); setGalPw2(''); setPwSuccess('Gallery password saved!'); setTimeout(() => setPwSuccess(''), 3000); };
  const handleAdmPw = async () => { setPwErr(''); setPwSuccess(''); if (adminPw.length < 4) { setPwErr('Min 4 chars'); return; } if (adminPw !== adminPw2) { setPwErr("Don't match"); return; } localStorage.setItem(ADMIN_PW_KEY, await sha256(adminPw)); setAdminPw(''); setAdminPw2(''); setPwSuccess('Admin password updated!'); setTimeout(() => setPwSuccess(''), 3000); };

  // Export config as encrypted file
  const exportConfig = async () => {
    setCfgMsg('');
    const cfg: ConfigData = { galPwHash: localStorage.getItem(GALLERY_PW_KEY) || '', adminPwHash: localStorage.getItem(ADMIN_PW_KEY) || '', folders, apiKey: localStorage.getItem(API_KEY_STORAGE) || '' };
    if (!cfg.galPwHash) { setCfgMsg('⚠️ Set gallery password first'); return; }
    try {
      const encrypted = await encryptData(JSON.stringify(cfg));
      const blob = new Blob([JSON.stringify({ data: encrypted })], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'config.enc.json'; a.click();
      URL.revokeObjectURL(url);
      setCfgMsg('✅ Config file downloaded! Place it in your project\'s public/ folder and redeploy.');
      setTimeout(() => setCfgMsg(''), 6000);
    } catch { setCfgMsg('❌ Failed to encrypt config.'); }
  };

  // Import config from file
  const importConfig = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setCfgMsg('');
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json.data) { setCfgMsg('❌ Invalid config file'); return; }
      const decrypted = await decryptData(json.data);
      const cfg = JSON.parse(decrypted) as ConfigData;
      if (cfg.galPwHash) localStorage.setItem(GALLERY_PW_KEY, cfg.galPwHash);
      if (cfg.adminPwHash) localStorage.setItem(ADMIN_PW_KEY, cfg.adminPwHash);
      if (cfg.folders?.length) { setFolders(cfg.folders); saveFolders(cfg.folders); }
      setCfgMsg('✅ Config imported! Passwords and folders restored.');
      setTimeout(() => setCfgMsg(''), 4000);
    } catch { setCfgMsg('❌ Could not read config file. It may be corrupted.'); }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="min-h-screen bg-dark-900 relative"><BgParticles />
      <header className="relative z-10 border-b border-white/5 glass"><div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between"><div className="flex items-center gap-2.5"><div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg"><Shield className="w-[18px] h-[18px] text-white" /></div><div><h1 className="text-white font-bold text-base">Admin Panel</h1><p className="text-white/30 text-[11px]">Manage folders & passwords</p></div></div><button onClick={onLogout} className="p-2 text-white/30 hover:text-red-400 rounded-lg transition"><LogOut className="w-[18px] h-[18px]" /></button></div></header>
      <main className="relative z-10 max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* Passwords */}
        <div className="bg-dark-800/80 backdrop-blur border border-white/10 rounded-2xl p-5 anim-fade-up"><h3 className="text-white text-sm font-semibold mb-4 flex items-center gap-2"><KeyRound className="w-4 h-4 text-amber-400" />Passwords</h3><div className="grid md:grid-cols-2 gap-4"><div className="space-y-2.5 p-4 bg-white/5 rounded-xl border border-white/5"><div className="flex items-center justify-between mb-2"><span className="text-white/70 text-xs font-medium">Gallery</span>{hasGalleryPw ? <span className="text-emerald-400/70 text-[10px] flex items-center gap-1"><div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />Set</span> : <span className="text-red-400/70 text-[10px] flex items-center gap-1"><div className="w-1.5 h-1.5 bg-red-400 rounded-full" />Not set</span>}</div><input type="password" value={galPw} onChange={e => setGalPw(e.target.value)} placeholder="New password" className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-amber-500/40" /><input type="password" value={galPw2} onChange={e => setGalPw2(e.target.value)} placeholder="Confirm" className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-amber-500/40" /><button onClick={handleGalPw} className="w-full py-2 bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 text-xs font-medium rounded-lg transition flex items-center justify-center gap-1.5"><Save className="w-3 h-3" />Set</button></div>
          <div className="space-y-2.5 p-4 bg-white/5 rounded-xl border border-white/5"><div className="flex items-center justify-between mb-2"><span className="text-white/70 text-xs font-medium">Admin</span><span className="text-emerald-400/70 text-[10px] flex items-center gap-1"><div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />Set</span></div><input type="password" value={adminPw} onChange={e => setAdminPw(e.target.value)} placeholder="New password" className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-amber-500/40" /><input type="password" value={adminPw2} onChange={e => setAdminPw2(e.target.value)} placeholder="Confirm" className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-amber-500/40" /><button onClick={handleAdmPw} className="w-full py-2 bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 text-xs font-medium rounded-lg transition flex items-center justify-center gap-1.5"><Save className="w-3 h-3" />Update</button></div></div>
          {pwErr && <p className="mt-3 text-red-400 text-[11px] flex items-center gap-1.5 bg-red-500/10 border border-red-500/15 rounded-lg px-3 py-2"><AlertCircle className="w-3 h-3 shrink-0" />{pwErr}</p>}{pwSuccess && <p className="mt-3 text-emerald-400 text-[11px] flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/15 rounded-lg px-3 py-2"><ShieldCheck className="w-3 h-3 shrink-0" />{pwSuccess}</p>}</div>
        {/* API Key */}
        <div className="bg-dark-800/80 backdrop-blur border border-white/10 rounded-2xl p-5 anim-fade-up" style={{ animationDelay: '40ms' }}>
          <h3 className="text-white text-sm font-semibold mb-2 flex items-center gap-2"><KeyRound className="w-4 h-4 text-cyan-400" />Google Drive API Key</h3>
          <p className="text-white/30 text-[11px] mb-3 leading-relaxed"><strong className="text-white/50">Required for large galleries.</strong> Without an API key, only ~50-100 photos may load. With an API key, the app loads <strong className="text-white/50">all images recursively</strong> — including images inside subfolders. Get a free key from <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-cyan-400/80 underline underline-offset-2">Google Cloud Console</a> (enable Drive API).</p>
          <div className="flex gap-2">
            <input type="password" value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)} placeholder="Paste API key…" className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 font-mono" />
            <button onClick={saveApiKey} className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 shrink-0 ${apiKeySaved ? 'bg-emerald-600/30 text-emerald-300' : 'bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-200'}`}>{apiKeySaved ? <><ShieldCheck className="w-3 h-3" />Saved</> : <><Save className="w-3 h-3" />Save</>}</button>
          </div>
          <button onClick={testApiKey} disabled={apiTesting}
            className="mt-2 w-full py-2 rounded-lg text-xs font-medium transition flex items-center justify-center gap-1.5 bg-white/5 hover:bg-white/10 text-white/50 hover:text-white/80 border border-white/5 disabled:opacity-40">
            {apiTesting ? <><span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />Testing…</> : <><Search className="w-3 h-3" />Test API Key</>}
          </button>
          {apiTestResult && <p className={`mt-2 text-[11px] px-3 py-2 rounded-lg ${apiTestResult.startsWith('✅') ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/15' : 'text-red-400 bg-red-500/10 border border-red-500/15'}`}>{apiTestResult}</p>}
          {getApiKey() && !apiTestResult && <div className="mt-2 flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-emerald-400 rounded-full" /><span className="text-emerald-400/60 text-[10px]">API key saved</span></div>}
        </div>
        {/* Add folder */}
        <div className="bg-dark-800/80 backdrop-blur border border-white/10 rounded-2xl p-5 anim-fade-up" style={{ animationDelay: '70ms' }}><h3 className="text-white text-sm font-semibold mb-3 flex items-center gap-2"><Plus className="w-4 h-4 text-emerald-400" />Add Google Drive Folder</h3><div className="space-y-2.5"><div className="relative"><Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25" /><input value={link} onChange={e => { setLink(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder="Paste folder link…" className="w-full pl-9 pr-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 font-mono" /></div><div className="relative"><FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25" /><input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder="Label (optional)" className="w-full pl-9 pr-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-emerald-500/40" /></div>{err && <p className="text-red-400 text-[11px] flex items-center gap-1.5 bg-red-500/10 rounded-lg px-3 py-2"><AlertCircle className="w-3 h-3 shrink-0" />{err}</p>}{success && <p className="text-emerald-400 text-[11px] flex items-center gap-1.5 bg-emerald-500/10 rounded-lg px-3 py-2"><ShieldCheck className="w-3 h-3 shrink-0" />{success}</p>}<button onClick={handleAdd} className="w-full py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-lg transition active:scale-[.97] flex items-center justify-center gap-1.5"><Plus className="w-3.5 h-3.5" />Add</button></div><div className="mt-3 p-3 bg-blue-500/8 border border-blue-500/15 rounded-xl"><p className="text-blue-300/60 text-[11px]"><strong className="text-blue-300/80">Tip:</strong> Share as <strong>"Anyone with the link"</strong> → Viewer</p></div></div>
        {/* Folder list */}
        <div className="bg-dark-800/80 backdrop-blur border border-white/10 rounded-2xl p-5 anim-fade-up" style={{ animationDelay: '100ms' }}><h3 className="text-white text-sm font-semibold mb-4 flex items-center gap-2"><Layers className="w-4 h-4 text-purple-400" />Folders ({folders.length})</h3>{folders.length === 0 ? <div className="text-center py-8"><Upload className="w-8 h-8 text-white/10 mx-auto mb-2" /><p className="text-white/25 text-xs">No folders yet</p></div> : <div className="space-y-2">{folders.map(f => (<div key={f.id} className="flex items-center justify-between gap-3 p-3 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition"><div className="flex items-center gap-2.5 min-w-0 flex-1"><div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-500/20 to-indigo-500/20 flex items-center justify-center shrink-0"><FolderOpen className="w-4 h-4 text-purple-400/80" /></div><div className="min-w-0"><p className="text-white text-sm font-medium truncate">{f.name}</p><p className="text-white/20 text-[10px] font-mono truncate">{f.folderId}</p></div></div><div className="flex items-center gap-1.5 shrink-0"><a href={f.link} target="_blank" rel="noopener noreferrer" className="p-1.5 text-white/20 hover:text-white/60 transition"><ExternalLink className="w-3.5 h-3.5" /></a><button onClick={() => setFolders(p => p.filter(x => x.id !== f.id))} className="p-1.5 text-white/20 hover:text-red-400 transition"><Trash2 className="w-4 h-4" /></button></div></div>))}</div>}</div>
        {/* Config file export/import */}
        <div className="bg-dark-800/80 backdrop-blur border border-amber-500/20 rounded-2xl p-5 anim-fade-up" style={{ animationDelay: '150ms' }}>
          <h3 className="text-white text-sm font-semibold mb-2 flex items-center gap-2"><Lock className="w-4 h-4 text-amber-400" />Config File (Encrypted)</h3>
          <p className="text-white/40 text-[11px] mb-4 leading-relaxed">Export your passwords & folder links as an <strong className="text-white/60">encrypted config file</strong>. Place it in the <code className="bg-white/5 px-1 rounded text-[10px]">public/</code> folder of your project so it loads automatically on every deploy.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <button onClick={exportConfig} className="py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 shadow-lg transition active:scale-[.97] flex items-center justify-center gap-2"><FileDown className="w-4 h-4" />Export Config</button>
            <button onClick={() => fileInputRef.current?.click()} className="py-3 rounded-xl text-sm font-semibold text-white glass hover:bg-white/[0.08] transition active:scale-[.97] flex items-center justify-center gap-2 border border-white/10"><FileUp className="w-4 h-4" />Import Config</button>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={importConfig} />
          </div>
          {cfgMsg && <p className={`mt-3 text-[11px] px-3 py-2 rounded-lg ${cfgMsg.startsWith('✅') ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/15' : cfgMsg.startsWith('❌') ? 'text-red-400 bg-red-500/10 border border-red-500/15' : 'text-amber-400 bg-amber-500/10 border border-amber-500/15'}`}>{cfgMsg}</p>}
          <div className="mt-3 p-3 bg-white/[0.02] border border-white/5 rounded-xl space-y-1">
            <p className="text-white/30 text-[10px] leading-relaxed">📁 <strong className="text-white/50">How it works:</strong></p>
            <ol className="text-white/25 text-[10px] leading-relaxed list-decimal list-inside space-y-0.5">
              <li>Set passwords & add folders above</li>
              <li>Click <strong className="text-white/40">Export Config</strong> → downloads <code className="bg-white/5 px-0.5 rounded">config.enc.json</code></li>
              <li>Place the file in your project's <code className="bg-white/5 px-0.5 rounded">public/</code> folder</li>
              <li>Deploy — passwords & folders auto-load for all visitors</li>
            </ol>
            <p className="text-white/20 text-[10px] mt-1">🔒 File is AES-256-GCM encrypted. Passwords are SHA-256 hashed inside.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ═══════════════ DOWNLOAD HELPER ═══════════════ */
async function downloadPhoto(photo: Photo) {
  // Try multiple URLs to get the actual image bytes
  const urls = [
    photo.full,
    `https://lh3.googleusercontent.com/d/${photo.fileId}=w0`,  // w0 = original size
    `https://drive.google.com/uc?export=download&id=${photo.fileId}`,
    photo.dl,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) continue;
      const blob = await res.blob();
      if (blob.size < 1000) continue; // too small, probably an error page

      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const fileName = photo.name.replace(/[^a-zA-Z0-9 —_-]/g, '') + '.' + ext;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      return;
    } catch {
      continue;
    }
  }

  // All fetch attempts failed — open in new tab as last resort
  window.open(`https://drive.google.com/uc?export=download&id=${photo.fileId}`, '_blank');
}

/* ═══════════════ LIGHTBOX ═══════════════ */
function Lightbox({ photos, index, onClose, onNav }: { photos: Photo[]; index: number; onClose: () => void; onNav: (i: number) => void }) {
  const [zoom, setZoom] = useState(1); const [rot, setRot] = useState(0); const [loading, setLoading] = useState(true); const [imgErr, setImgErr] = useState(false);
  const photo = photos[index];
  const reset = useCallback(() => { setZoom(1); setRot(0); setLoading(true); setImgErr(false); }, []);
  const next = useCallback(() => { if (index < photos.length - 1) { onNav(index + 1); reset(); } }, [index, photos.length, onNav, reset]);
  const prev = useCallback(() => { if (index > 0) { onNav(index - 1); reset(); } }, [index, onNav, reset]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') prev(); }; window.addEventListener('keydown', h); document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', h); document.body.style.overflow = ''; }; }, [next, prev, onClose]);
  const thumbRef = useRef<HTMLDivElement>(null);
  useEffect(() => { thumbRef.current?.querySelector(`[data-idx="${index}"]`)?.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' }); }, [index]);
  const [src, setSrc] = useState(photo.full);
  useEffect(() => { setSrc(photo.full); setImgErr(false); setLoading(true); }, [photo.full]);
  const handleError = () => { if (src === photo.full) setSrc(`https://drive.google.com/thumbnail?id=${photo.fileId}&sz=w1920`); else if (src.includes('thumbnail?id=')) setSrc(photo.dl); else { setImgErr(true); setLoading(false); } };

  const handleDownload = async () => {
    await downloadPhoto(photo);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/[0.97] backdrop-blur-xl flex flex-col anim-scale-in">
      <div className="flex items-center justify-between px-4 py-3 shrink-0 bg-gradient-to-b from-black/60 to-transparent"><span className="text-white/50 text-sm font-mono tabular-nums"><span className="text-white font-semibold">{index + 1}</span><span className="text-white/20"> / </span>{photos.length}</span><div className="flex items-center gap-1">{[{ icon: ZoomIn, fn: () => setZoom(z => Math.min(z + .25, 4)) }, { icon: ZoomOut, fn: () => setZoom(z => Math.max(z - .25, .5)) }, { icon: RotateCw, fn: () => setRot(r => r + 90) }].map((b, i) => (<button key={i} onClick={b.fn} className="p-2.5 text-white/30 hover:text-white hover:bg-white/10 rounded-xl transition"><b.icon className="w-5 h-5" /></button>))}<button onClick={handleDownload} className="p-2.5 text-white/30 hover:text-white hover:bg-white/10 rounded-xl transition" title="Download"><Download className="w-5 h-5" /></button><div className="w-px h-6 bg-white/10 mx-1" /><button onClick={onClose} className="p-2.5 text-white/30 hover:text-white hover:bg-white/10 rounded-xl transition"><X className="w-5 h-5" /></button></div></div>
      <div className="flex-1 flex items-center justify-center relative overflow-hidden select-none px-4"><button onClick={prev} disabled={index === 0} className="absolute left-3 z-10 p-3 rounded-2xl bg-white/5 hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-0 transition-all backdrop-blur"><ChevronLeft className="w-7 h-7" /></button>{loading && !imgErr && <div className="absolute inset-0 flex items-center justify-center"><div className="w-10 h-10 border-2 border-white/10 border-t-amber-400 rounded-full animate-spin" /></div>}{imgErr ? <div className="flex flex-col items-center gap-4 text-white/25"><Images className="w-14 h-14" /><p className="text-sm">Could not load</p><button onClick={handleDownload} className="text-xs text-purple-400 underline underline-offset-2 hover:text-purple-300 transition">Download Original</button></div> : <img src={src} alt={photo.name} draggable={false} className="max-w-full max-h-full object-contain transition-all duration-300 rounded-lg" style={{ transform: `scale(${zoom}) rotate(${rot}deg)`, opacity: loading ? 0 : 1 }} onLoad={() => setLoading(false)} onError={handleError} referrerPolicy="no-referrer" />}<button onClick={next} disabled={index === photos.length - 1} className="absolute right-3 z-10 p-3 rounded-2xl bg-white/5 hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-0 transition-all backdrop-blur"><ChevronRight className="w-7 h-7" /></button></div>
      <div className="bg-gradient-to-t from-black/60 to-transparent pt-2 pb-3"><div className="text-center mb-2"><span className="text-white/30 text-[11px] truncate block max-w-sm mx-auto">{photo.name}</span></div><div ref={thumbRef} className="flex items-center justify-start overflow-x-auto gap-2 px-4">{photos.map((p, i) => (<button key={`${p.id}-${i}`} data-idx={i} onClick={() => { onNav(i); reset(); }} className={`shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition-all duration-200 ${i === index ? 'border-amber-500 ring-2 ring-amber-500/30 scale-110' : 'border-transparent opacity-35 hover:opacity-60'}`}><img src={p.thumb} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" /></button>))}</div></div>
    </div>
  );
}

/* ═══════════════ WELCOME POPUP ═══════════════ */
const WELCOME_SEEN_KEY = 'gal_welcome_seen';

function WelcomePopup({ onClose, onFindMyPhotos }: { onClose: () => void; onFindMyPhotos: () => void }) {
  const dismiss = () => { localStorage.setItem(WELCOME_SEEN_KEY, '1'); onClose(); };
  const startAi = () => { localStorage.setItem(WELCOME_SEEN_KEY, '1'); onFindMyPhotos(); };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={dismiss} />

      {/* Card */}
      <div className="relative w-full max-w-md glass-card rounded-[32px] p-8 shadow-2xl shadow-black/60 anim-scale-in border border-amber-500/10">
        {/* Close */}
        <button onClick={dismiss} className="absolute top-5 right-5 p-2 rounded-xl text-white/20 hover:text-white/50 hover:bg-white/5 transition">
          <X className="w-5 h-5" />
        </button>

        {/* Icon */}
        <div className="flex flex-col items-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500 via-yellow-600 to-orange-600 flex items-center justify-center shadow-xl shadow-amber-600/25 mb-4 anim-glow">
            <Heart className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-xl font-bold text-gradient text-center">Welcome to the Wedding Album! 💍</h2>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-6">
          {[
            { emoji: '📸', title: 'Browse All Photos', desc: 'Scroll through all the wedding moments. Use grid or masonry view.' },
            { emoji: '🔍', title: 'Search & Sort', desc: 'Search by name or sort by date, name, or folder.' },
            { emoji: '🤖', title: 'Find Your Photos with AI', desc: 'Upload a selfie and AI will show only the moments that include you.' },
            { emoji: '⬇️', title: 'Download', desc: 'Open any photo and tap the download button to save it.' },
          ].map((step, i) => (
            <div key={i} className="flex items-start gap-3.5 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.04]">
              <span className="text-xl shrink-0 mt-0.5">{step.emoji}</span>
              <div>
                <p className="text-white text-sm font-medium">{step.title}</p>
                <p className="text-amber-100/25 text-xs mt-0.5 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="space-y-2.5">
          <button onClick={startAi}
            className="w-full py-3.5 rounded-2xl font-semibold text-sm text-white bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 shadow-lg shadow-rose-700/15 transition-all active:scale-[.97] flex items-center justify-center gap-2 btn-shine">
            <ScanFace className="w-5 h-5" /> Find My Photos with AI
          </button>
          <button onClick={dismiss}
            className="w-full py-3.5 rounded-2xl font-medium text-sm text-amber-100/40 hover:text-amber-100/70 glass hover:bg-white/[0.04] transition-all active:scale-[.98] flex items-center justify-center gap-2">
            <Images className="w-5 h-5" /> Just Browse All Photos
          </button>
        </div>

        <div className="mt-5 space-y-1.5">
          <p className="text-center text-amber-200/10 text-[10px] italic">This message appears only once</p>
        </div>
      </div>
    </div>
  );
}

function FolderFilterPopup({
  folders,
  enabled,
  counts,
  onToggle,
  onSelectAll,
  onClearAll,
  onClose,
}: {
  folders: GDriveFolder[];
  enabled: Set<string>;
  counts: Record<string, number>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const dismiss = () => { onClose(); };
  return (
    <div className="fixed inset-0 z-[68] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={dismiss} />
      <div className="relative w-full max-w-md glass-card rounded-[32px] p-7 shadow-2xl shadow-black/60 anim-scale-in border border-amber-500/10">
        <button onClick={dismiss} className="absolute top-4 right-4 p-2 rounded-xl text-white/20 hover:text-white/50 hover:bg-white/5 transition">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-700/20">
            <FolderOpen className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gradient">Choose Albums</h3>
            <p className="text-amber-100/25 text-xs">Only selected albums will be shown</p>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <button onClick={onSelectAll} className="flex-1 py-2.5 rounded-xl text-xs font-medium glass text-amber-100/60 hover:text-amber-100 transition">Select All</button>
          <button onClick={onClearAll} className="flex-1 py-2.5 rounded-xl text-xs font-medium glass text-amber-100/60 hover:text-amber-100 transition">Clear All</button>
        </div>

        <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
          {folders.map((f) => {
            const isOn = enabled.has(f.folderId);
            return (
              <button key={f.id} onClick={() => onToggle(f.folderId)}
                className={`w-full flex items-center justify-between gap-3 p-3 rounded-2xl border transition-all ${
                  isOn ? 'bg-amber-500/10 border-amber-500/20' : 'bg-white/[0.03] border-white/[0.05]'
                }`}>
                <div className="flex items-center gap-3 min-w-0 text-left">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isOn ? 'bg-gradient-to-br from-amber-500 to-orange-600 text-white' : 'bg-white/[0.05] text-white/30'}`}>
                    <FolderOpen className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className={`text-sm truncate ${isOn ? 'text-white' : 'text-white/50'}`}>{f.name}</p>
                    <p className="text-[10px] text-amber-100/20">{counts[f.folderId] || 0} photos</p>
                  </div>
                </div>
                <div className={`w-12 h-7 rounded-full p-1 transition-all ${isOn ? 'bg-amber-500/30' : 'bg-white/[0.06]'}`}>
                  <div className={`w-5 h-5 rounded-full bg-white transition-all ${isOn ? 'translate-x-5' : 'translate-x-0'} shadow-md`} />
                </div>
              </button>
            );
          })}
        </div>

        <button onClick={dismiss}
          className="mt-5 w-full py-3.5 rounded-2xl font-semibold text-sm text-white bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 shadow-lg shadow-amber-700/15 transition-all active:scale-[.97] btn-shine">
          Done
        </button>
      </div>
    </div>
  );
}

/* ═══════════════ GALLERY ═══════════════ */
function Gallery({ faceDescriptor, onLogout, onSetFaceDescriptor }: { faceDescriptor: Float32Array | null; onLogout: () => void; onSetFaceDescriptor: (d: Float32Array | null) => void }) {
  const [folders] = useState<GDriveFolder[]>(() => loadFolders());
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]); const [matchedPhotos, setMatchedPhotos] = useState<Photo[] | null>(null);
  const [loadingPhotos, setLoadingPhotos] = useState(true); const [scanning, setScanning] = useState(false); const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState<number | null>(null); const [layout, setLayout] = useState<'grid' | 'masonry'>('grid'); const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('date-new');
  const [loaded, setLoaded] = useState<Set<string>>(new Set()); const [failed, setFailed] = useState<Set<string>>(new Set()); void failed; // keep tracking for debug
  const [foldersLoaded, setFoldersLoaded] = useState(0); const [scanProgress, setScanProgress] = useState(0); const [scanTotal, setScanTotal] = useState(0); const [showAll, setShowAll] = useState(false);
  const scanTip = useCyclingTip(_SCAN_TIPS);
  const [faceCaptureOpen, setFaceCaptureOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem(WELCOME_SEEN_KEY));
  const [showFolderPopup, setShowFolderPopup] = useState(() => folders.length > 1);
  const [enabledFolders, setEnabledFolders] = useState<string[]>(() => folders.map(f => f.folderId));
  const addLog = useCallback((msg: string) => { console.log(msg); }, []);

  const loadPhotos = useCallback(async () => {
    setLoadingPhotos(true); setError(''); setLoaded(new Set()); setFailed(new Set()); setAllPhotos([]); setMatchedPhotos(null); setFoldersLoaded(0);
    addLog(`Starting load — ${folders.length} folder(s), API key: ${getApiKey() ? 'YES' : 'NO'}`);
    try {
      const all: Photo[] = [];
      const errors: string[] = [];
      for (const f of folders) {
        addLog(`Loading "${f.name}" (${f.folderId})...`);
        try {
          const files = await fetchFolderFileIds(f.folderId);
          addLog(`  ✅ "${f.name}": ${files.length} images [${getLastApiStatus()}]`);
          all.push(...files.map((fi, i) => ({
            id: fi.id, fileId: fi.id,
            name: `${f.name} — Photo ${i + 1}`,
            thumb: makeThumb(fi.id), full: makeFull(fi.id), dl: makeDl(fi.id),
            folder: f.name,
            folderId: f.folderId,
            createdTime: fi.createdTime || '',
          })));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          addLog(`  ❌ "${f.name}" FAILED: ${msg}`);
          errors.push(f.name);
        }
        setFoldersLoaded(n => n + 1);
      }
      setAllPhotos(all);
      addLog(`Done — ${all.length} total photos loaded`);
      if (!all.length && folders.length > 0) {
        setError(`No images found.${errors.length ? ` Failed: ${errors.join(', ')}.` : ''} Check API key & folder sharing.`);
      }
      if (!folders.length) setError('No albums configured. Contact admin.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(`Fatal error: ${msg}`);
      setError('Something went wrong loading photos.');
    }
    setLoadingPhotos(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  // ── AI Face Scan — uses FaceMatcher for better accuracy ──
  useEffect(() => {
    if (loadingPhotos || !faceDescriptor || allPhotos.length === 0) return;
    let cancelled = false;
    const MATCH_THRESHOLD = 0.55; // lower = stricter, higher = more lenient
    const BATCH = 5;
    const scanUrl = (fid: string) => `https://lh3.googleusercontent.com/d/${fid}=w320`;

    // Create a FaceMatcher from the reference face — AI handles matching
    const labeledDescriptor = new faceapi.LabeledFaceDescriptors('user', [faceDescriptor]);
    const matcher = new faceapi.FaceMatcher(labeledDescriptor, MATCH_THRESHOLD);

    // Use SSD MobileNet for scanning — more accurate than TinyFaceDetector
    const ssdOpts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 });
    // TinyFaceDetector as fast fallback
    const tinyOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.3 });

    // Reliable image loader
    const loadScanImage = (url: string): Promise<HTMLImageElement | null> => {
      return new Promise(resolve => {
        const img = document.createElement('img');
        img.crossOrigin = 'anonymous';
        img.setAttribute('referrerpolicy', 'no-referrer');
        img.style.position = 'fixed';
        img.style.left = '-9999px';
        img.style.visibility = 'hidden';
        img.onload = () => { try { document.body.removeChild(img); } catch {} resolve(img); };
        img.onerror = () => { try { document.body.removeChild(img); } catch {} resolve(null); };
        document.body.appendChild(img);
        img.src = url;
        setTimeout(() => { img.onload = null; img.onerror = null; try { document.body.removeChild(img); } catch {} resolve(null); }, 10000);
      });
    };

    // Scan one photo — try SSD first, fallback to Tiny
    const scanPhoto = async (_photo: Photo, img: HTMLImageElement): Promise<boolean> => {
      // Try SSD MobileNet (more accurate)
      let dets = await faceapi.detectAllFaces(img, ssdOpts).withFaceLandmarks().withFaceDescriptors();

      // If SSD found nothing, try TinyFaceDetector as fallback
      if (dets.length === 0) {
        dets = await faceapi.detectAllFaces(img, tinyOpts).withFaceLandmarks().withFaceDescriptors();
      }

      if (dets.length === 0) return false;

      // Use FaceMatcher to check each detected face
      for (const det of dets) {
        const match = matcher.findBestMatch(det.descriptor);
        if (match.label === 'user') return true; // AI says it's the same person
      }
      return false;
    };

    (async () => {
      setScanning(true);
      setScanTotal(allPhotos.length);
      setScanProgress(0);
      const matches: Photo[] = [];

      // Preloading system
      const preloading = new Map<string, Promise<HTMLImageElement | null>>();
      const preload = (start: number, count: number) => {
        for (let j = start; j < Math.min(start + count, allPhotos.length); j++) {
          const fid = allPhotos[j].fileId;
          if (!preloading.has(fid)) preloading.set(fid, loadScanImage(scanUrl(fid)));
        }
      };

      // Preload first chunk
      preload(0, BATCH * 4);

      for (let i = 0; i < allPhotos.length; i += BATCH) {
        if (cancelled) break;

        // Keep preloading ahead
        preload(i + BATCH, BATCH * 4);

        const batch = allPhotos.slice(i, i + BATCH);

        for (const photo of batch) {
          if (cancelled) break;
          try {
            const cached = preloading.get(photo.fileId);
            const img = cached ? await cached : await loadScanImage(scanUrl(photo.fileId));
            if (img && img.naturalWidth) {
              const isMatch = await scanPhoto(photo, img);
              if (isMatch) matches.push(photo);
            }
          } catch { /* skip */ }
        }

        setScanProgress(Math.min(i + BATCH, allPhotos.length));
        setMatchedPhotos([...matches]);
      }

      if (!cancelled) {
        setMatchedPhotos(matches);
        setScanning(false);
        console.log(`AI Face Scan complete: ${matches.length} matches out of ${allPhotos.length}`);
      }
    })();

    return () => { cancelled = true; };
  }, [loadingPhotos, faceDescriptor, allPhotos]);

  const PAGE_SIZE = 60;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Keep enabled folders in sync with current folder list and persist per user
  useEffect(() => {
    const currentIds = folders.map(f => f.folderId);
    setEnabledFolders(prev => {
      const prevSet = new Set(prev.length ? prev : currentIds);
      const next = currentIds.filter(id => prevSet.has(id));
      currentIds.forEach(id => { if (!next.includes(id)) next.push(id); });
      return next;
    });
  }, [folders]);

  const enabledSet = new Set(enabledFolders);
  const displayPhotos = (!faceDescriptor || showAll) ? allPhotos : (matchedPhotos ?? []);
  const isReady = !loadingPhotos;
  const folderFiltered = displayPhotos.filter(p => enabledSet.has(p.folderId));
  const folderCounts = displayPhotos.reduce<Record<string, number>>((acc, p) => { acc[p.folderId] = (acc[p.folderId] || 0) + 1; return acc; }, {});
  // Don't exclude failed thumbs from dataset — keep them in gallery and let browser retry/lazy load
  const filtered = folderFiltered.filter(p => !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.folder.toLowerCase().includes(query.toLowerCase()));

  // Sort
  const allVisible = [...filtered].sort((a, b) => {
    switch (sortMode) {
      case 'date-new': return (b.createdTime || '').localeCompare(a.createdTime || '');
      case 'date-old': return (a.createdTime || '').localeCompare(b.createdTime || '');
      case 'name-az': return a.name.localeCompare(b.name);
      case 'name-za': return b.name.localeCompare(a.name);
      case 'folder-az': {
        const byFolder = a.folder.localeCompare(b.folder);
        return byFolder !== 0 ? byFolder : a.name.localeCompare(b.name);
      }
      case 'folder-za': {
        const byFolder = b.folder.localeCompare(a.folder);
        return byFolder !== 0 ? byFolder : a.name.localeCompare(b.name);
      }
      default: return 0;
    }
  });
  const visible = allVisible.slice(0, visibleCount);
  const hasMore = visibleCount < allVisible.length;

  // Reset visible count whenever the underlying result set changes
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [showAll, query, faceDescriptor, matchedPhotos, allPhotos.length, displayPhotos.length, enabledFolders.join('|')]);

  const loadMore = useCallback(() => {
    setVisibleCount(c => Math.min(c + PAGE_SIZE, allVisible.length));
  }, [allVisible.length]);

  const loadAll = useCallback(() => {
    setVisibleCount(allVisible.length);
  }, [allVisible.length]);

  // Infinite scroll — observe sentinel element
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore) loadMore();
      },
      { rootMargin: '900px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, visible.length, loadMore]);

  // Backup auto-load on window scroll for browsers where IntersectionObserver is flaky
  useEffect(() => {
    const onScroll = () => {
      if (!hasMore) return;
      const scrollBottom = window.innerHeight + window.scrollY;
      const docHeight = document.documentElement.scrollHeight;
      if (docHeight - scrollBottom < 1200) loadMore();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [hasMore, loadMore]);

  return (
    <div className="min-h-screen bg-dark-900">
      {loadingPhotos && <FancyLoader tips={LOADING_TIPS} progress={foldersLoaded} total={folders.length} label="albums loaded" />}
      {isReady && (<>
        {/* Scanning progress bar — inline, not blocking */}
        {scanning && faceDescriptor && (
          <div className="fixed top-0 left-0 right-0 z-40">
            <div className="h-1 bg-white/[0.03]">
              <div className="h-full bg-gradient-to-r from-rose-500 via-amber-400 to-rose-500 transition-all duration-300 ease-out grad-move"
                style={{ width: `${scanTotal > 0 ? Math.round((scanProgress / scanTotal) * 100) : 0}%` }} />
            </div>
            <div className="glass-strong border-b border-white/5 px-4 py-2 flex items-center justify-center gap-3">
              <span className="w-4 h-4 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin" />
              <span className="text-white/50 text-xs hidden sm:inline">{scanTip}</span>
              <span className="text-white/50 text-xs sm:hidden">AI Scanning… <span className="text-white/70 font-mono">{scanProgress}/{scanTotal}</span></span>
              <span className="text-emerald-400/70 text-xs font-medium">{matchedPhotos?.length || 0} found</span>
              <span className="px-1.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300/60 text-[9px] font-bold uppercase hidden sm:inline">AI</span>
              <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400/60 text-[9px] font-bold uppercase hidden sm:inline">Beta</span>
            </div>
          </div>
        )}
        <header className={`sticky top-0 z-30 glass-strong border-b border-white/[0.04] ${scanning ? 'mt-[52px]' : ''}`}><div className="max-w-[1440px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-4"><div className="flex items-center gap-3 min-w-0"><div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-600 to-orange-600 flex items-center justify-center shrink-0 shadow-lg shadow-amber-700/20 anim-glow"><Heart className="w-[18px] h-[18px] text-white" /></div><div className="min-w-0"><h2 className="text-white font-semibold text-[15px] truncate flex items-center gap-1.5">{faceDescriptor && !showAll ? '💫 Your Moments' : '💍 Wedding Album'}{faceDescriptor && !showAll && <><span className="px-1.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[8px] font-bold uppercase tracking-wider border border-rose-500/20 shrink-0">AI</span><span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[8px] font-bold uppercase tracking-wider border border-amber-500/20 shrink-0">Beta</span></>}</h2><p className="text-amber-100/25 text-[11px] font-light">{faceDescriptor && !showAll ? `${allVisible.length} moments found by AI` : hasMore ? `${visible.length} of ${allVisible.length} memories` : `${allVisible.length} memories`}</p></div></div><div className="flex items-center gap-2"><button onClick={() => setShowFolderPopup(true)} className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold glass text-amber-100/40 hover:text-amber-100/70 transition-all"><FolderOpen className="w-3.5 h-3.5" />Albums</button>{faceDescriptor ? (
              <button onClick={() => setShowAll(v => !v)} className={`hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all ${showAll ? 'bg-rose-500/15 text-rose-300 border border-rose-500/20' : 'glass text-amber-100/40 hover:text-amber-100/70'}`}>{showAll ? <><ScanFace className="w-3.5 h-3.5" />My Moments</> : <><Layers className="w-3.5 h-3.5" />All Photos</>}</button>
            ) : (
              <button onClick={() => setFaceCaptureOpen(true)} className="hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 shadow-lg shadow-rose-700/15 transition-all btn-shine">
                <ScanFace className="w-3.5 h-3.5" /> Find My Photos
              </button>
            )}<div className="relative hidden sm:block"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search moments…" className="pl-9 pr-4 py-2 w-44 glass rounded-xl text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-amber-500/25" /></div><select value={sortMode} onChange={e => setSortMode(e.target.value as SortMode)} className="hidden sm:block glass rounded-xl text-white text-[11px] px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500/25 bg-transparent appearance-none cursor-pointer" style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.3)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center', paddingRight: '24px' }}><option value="date-new" className="bg-dark-800 text-white">Newest First</option><option value="date-old" className="bg-dark-800 text-white">Oldest First</option><option value="name-az" className="bg-dark-800 text-white">Name A–Z</option><option value="name-za" className="bg-dark-800 text-white">Name Z–A</option><option value="folder-az" className="bg-dark-800 text-white">Folder A–Z</option><option value="folder-za" className="bg-dark-800 text-white">Folder Z–A</option></select><div className="flex glass rounded-xl p-0.5"><button onClick={() => setLayout('grid')} className={`p-2 rounded-lg transition ${layout === 'grid' ? 'bg-amber-600/80 text-white shadow-md' : 'text-white/30 hover:text-white/60'}`}><Grid3X3 className="w-4 h-4" /></button><button onClick={() => setLayout('masonry')} className={`p-2 rounded-lg transition ${layout === 'masonry' ? 'bg-amber-600/80 text-white shadow-md' : 'text-white/30 hover:text-white/60'}`}><LayoutGrid className="w-4 h-4" /></button></div><button onClick={loadPhotos} className="p-2 text-white/25 hover:text-white glass rounded-xl transition"><RefreshCw className="w-4 h-4" /></button><button onClick={onLogout} className="p-2 text-white/25 hover:text-red-400 glass rounded-xl transition"><LogOut className="w-[18px] h-[18px]" /></button></div></div></header>
        <main className="max-w-[1440px] mx-auto px-4 md:px-6 py-6">
          {faceDescriptor ? (
            !error && <button onClick={() => setShowAll(v => !v)} className={`sm:hidden w-full mb-4 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold transition-all ${showAll ? 'bg-rose-500/15 text-rose-300 border border-rose-500/20' : 'glass text-amber-100/40'}`}>{showAll ? <><ScanFace className="w-4 h-4" />Show My Moments Only</> : <><Layers className="w-4 h-4" />Show All Photos</>}</button>
          ) : (
            <button onClick={() => setFaceCaptureOpen(true)} className="sm:hidden w-full mb-4 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold text-white bg-gradient-to-r from-rose-600 to-amber-600 shadow-lg shadow-rose-700/15 btn-shine">
              <ScanFace className="w-4 h-4" /> Find My Photos with AI
            </button>
          )}

          {/* Mobile albums button */}
          <button onClick={() => setShowFolderPopup(true)} className="sm:hidden w-full mb-4 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold glass text-amber-100/40 hover:text-amber-100/70 transition-all">
            <FolderOpen className="w-4 h-4" /> Choose Albums
          </button>

          {/* Mobile: search + sort row */}
          <div className="sm:hidden flex gap-2 mb-5">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…"
                className="w-full pl-9 pr-3 py-2.5 glass rounded-xl text-white text-xs placeholder-white/20 focus:outline-none" />
            </div>
            <select value={sortMode} onChange={e => setSortMode(e.target.value as SortMode)}
              className="glass rounded-xl text-white text-[11px] px-3 py-2.5 focus:outline-none bg-transparent">
              <option value="date-new" className="bg-dark-800 text-white">Newest</option>
              <option value="date-old" className="bg-dark-800 text-white">Oldest</option>
              <option value="name-az" className="bg-dark-800 text-white">A–Z</option>
              <option value="name-za" className="bg-dark-800 text-white">Z–A</option>
              <option value="folder-az" className="bg-dark-800 text-white">Folder A–Z</option>
              <option value="folder-za" className="bg-dark-800 text-white">Folder Z–A</option>
            </select>
          </div>

          {/* AI prompt inside gallery */}
          {!faceDescriptor && !error && (
            <div className="mb-6 rounded-3xl overflow-hidden border border-amber-500/10 glass-card anim-fade-up">
              <div className="p-5 md:p-6 flex flex-col md:flex-row items-start md:items-center gap-4 justify-between">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-700/20 shrink-0">
                    <ScanFace className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <h3 className="text-white text-base font-semibold">Find your photos with AI</h3>
                      <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[9px] font-bold uppercase tracking-wider border border-rose-500/20">AI</span>
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[9px] font-bold uppercase tracking-wider border border-amber-500/20">Beta</span>
                    </div>
                    <p className="text-amber-100/28 text-sm leading-relaxed max-w-2xl">Sharing this album with family? Upload a selfie and we’ll try to show only the moments that include you.</p>
                  </div>
                </div>
                <button onClick={() => setFaceCaptureOpen(true)}
                  className="w-full md:w-auto px-5 py-3 rounded-2xl text-sm font-semibold text-white bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 shadow-lg shadow-rose-700/15 transition-all active:scale-[.97] flex items-center justify-center gap-2 btn-shine">
                  <ScanFace className="w-4 h-4" /> Start Face Recognition
                </button>
              </div>
            </div>
          )}

          {error && <div className="flex flex-col items-center py-32 anim-fade-up"><Images className="w-14 h-14 text-white/[0.06] mb-4" /><p className="text-white/35 text-sm text-center max-w-sm">{error}</p><button onClick={loadPhotos} className="mt-5 px-5 py-2.5 glass text-purple-300 text-xs rounded-xl transition hover:bg-white/5">Retry</button></div>}
          {!error && enabledFolders.length === 0 && (
            <div className="flex flex-col items-center py-24 anim-fade-up">
              <div className="w-20 h-20 rounded-3xl glass flex items-center justify-center mb-5"><FolderOpen className="w-10 h-10 text-white/10" /></div>
              <p className="text-amber-100/40 text-base font-medium">No albums selected</p>
              <p className="text-amber-100/20 text-sm mt-1 mb-6">Choose one or more albums to view photos</p>
              <button onClick={() => setShowFolderPopup(true)} className="px-6 py-3 bg-gradient-to-r from-amber-600 to-orange-600 text-white text-sm font-semibold rounded-2xl shadow-xl shadow-amber-700/20 transition active:scale-[.97] flex items-center gap-2 btn-shine grad-move"><FolderOpen className="w-5 h-5" />Choose Albums</button>
            </div>
          )}
          {!error && enabledFolders.length > 0 && faceDescriptor && !showAll && matchedPhotos && matchedPhotos.length === 0 && <div className="flex flex-col items-center py-32 anim-fade-up"><div className="w-20 h-20 rounded-3xl glass flex items-center justify-center mb-5"><ScanFace className="w-10 h-10 text-white/10" /></div><p className="text-amber-100/40 text-base font-medium">Couldn't find you in the wedding photos</p><p className="text-amber-100/20 text-sm mt-1">Try a clearer selfie with good lighting</p><p className="text-amber-300/20 text-[10px] mt-2 mb-6 flex items-center gap-1 italic"><Sparkles className="w-3 h-3" /> AI face recognition is in beta</p><button onClick={() => setShowAll(true)} className="px-6 py-3 bg-gradient-to-r from-amber-600 to-orange-600 text-white text-sm font-semibold rounded-2xl shadow-xl shadow-amber-700/20 transition active:scale-[.97] flex items-center gap-2 btn-shine grad-move"><Heart className="w-5 h-5" />Browse All Wedding Photos</button></div>}
          {/* Grid Layout */}
          {!error && visible.length > 0 && layout === 'grid' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {visible.map((p, i) => (
                <button key={`${p.id}-${i}`} onClick={() => setLightbox(i)}
                  className="photo-card group relative aspect-square rounded-2xl bg-dark-800 border border-white/[0.04] anim-card-in"
                  style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}>
                  {!loaded.has(p.id) && <div className="absolute inset-0 shimmer rounded-2xl" />}
                  <img src={p.thumb} alt={p.name} loading="lazy" referrerPolicy="no-referrer"
                    className={`w-full h-full object-cover rounded-2xl transition-all duration-700 group-hover:scale-[1.08] ${loaded.has(p.id) ? 'opacity-100' : 'opacity-0'}`}
                    onLoad={() => setLoaded(s => new Set(s).add(p.id))} onError={() => setFailed(s => new Set(s).add(p.id))} />
                  {/* Overlay */}
                  <div className="absolute inset-0 rounded-2xl bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-400 z-[2]" />
                  {/* Info */}
                  <div className="absolute bottom-0 left-0 right-0 p-3 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0 z-[3]">
                    <p className="text-white text-xs truncate font-medium drop-shadow">{p.name}</p>
                    <p className="text-white/40 text-[9px] mt-0.5">{p.folder}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* Masonry Layout */}
          {!error && visible.length > 0 && layout === 'masonry' && (
            <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-3 [&>button]:mb-3">
              {visible.map((p, i) => (
                <button key={`${p.id}-${i}`} onClick={() => setLightbox(i)}
                  className="photo-card group relative w-full rounded-2xl bg-dark-800 border border-white/[0.04] break-inside-avoid block anim-card-in"
                  style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}>
                  {!loaded.has(p.id) && <div className="w-full pt-[75%] shimmer rounded-2xl" />}
                  <img src={p.thumb} alt={p.name} loading="lazy" referrerPolicy="no-referrer"
                    className={`w-full h-auto rounded-2xl transition-all duration-700 group-hover:scale-[1.03] ${loaded.has(p.id) ? 'opacity-100' : 'opacity-0'}`}
                    onLoad={() => setLoaded(s => new Set(s).add(p.id))} onError={() => setFailed(s => new Set(s).add(p.id))} />
                  <div className="absolute inset-0 rounded-2xl bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-400 z-[2]" />
                </button>
              ))}
            </div>
          )}
          {!error && allVisible.length > 0 && !visible.length && query && <div className="flex flex-col items-center py-32"><Search className="w-12 h-12 text-white/[0.06] mb-4" /><p className="text-white/35 text-sm">No results for "{query}"</p></div>}

          {/* Infinite scroll sentinel + Load more */}
          {visible.length > 0 && (
            <div ref={sentinelRef} className="mt-6">
              {hasMore ? (
                <div className="flex flex-col items-center gap-3 py-8">
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <button onClick={loadMore}
                      className="px-6 py-3 glass rounded-2xl text-sm font-medium text-white/50 hover:text-white hover:bg-white/[0.06] transition-all active:scale-[.97] flex items-center gap-2">
                      <RefreshCw className="w-4 h-4" /> Load More Photos
                    </button>
                    <button onClick={loadAll}
                      className="px-6 py-3 rounded-2xl text-sm font-medium text-white bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 shadow-lg shadow-amber-700/20 transition-all active:scale-[.97] flex items-center gap-2 btn-shine">
                      <Layers className="w-4 h-4" /> Load All
                    </button>
                  </div>
                  <p className="text-white/15 text-[10px]">Showing {visible.length} of {allVisible.length}</p>
                </div>
              ) : (
                allVisible.length > PAGE_SIZE && (
                  <p className="text-center text-white/10 text-[11px] py-6">All {allVisible.length} photos loaded</p>
                )
              )}
            </div>
          )}
        </main>
        {/* Welcome popup — first visit only */}
        {showWelcome && (
          <WelcomePopup
            onClose={() => setShowWelcome(false)}
            onFindMyPhotos={() => { setShowWelcome(false); setFaceCaptureOpen(true); }}
          />
        )}

        {/* Albums popup — first time / on demand */}
        {showFolderPopup && !showWelcome && (
          <FolderFilterPopup
            folders={folders}
            enabled={enabledSet}
            counts={folderCounts}
            onToggle={(id) => setEnabledFolders(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
            onSelectAll={() => setEnabledFolders(folders.map(f => f.folderId))}
            onClearAll={() => setEnabledFolders([])}
            onClose={() => setShowFolderPopup(false)}
          />
        )}

        {/* Face capture overlay — keeps gallery mounted */}
        {faceCaptureOpen && (
          <div className="fixed inset-0 z-[60]">
            <FaceCapture
              onCapture={(d) => { onSetFaceDescriptor(d); setShowAll(false); setFaceCaptureOpen(false); }}
              onSkip={() => { setFaceCaptureOpen(false); }}
              onClose={() => setFaceCaptureOpen(false)}
            />
          </div>
        )}

        {lightbox !== null && <Lightbox photos={visible} index={lightbox} onClose={() => setLightbox(null)} onNav={setLightbox} />}
      </>)}
    </div>
  );
}

/* ═══════════════ ROOT ═══════════════ */
export default function App() {
  const [mode, setMode] = useState<AppMode>('gallery-login');
  const [faceDescriptor, setFaceDescriptor] = useState<Float32Array | null>(null);
  const [configReady, setConfigReady] = useState(false);

  // Load encrypted config file on startup
  useEffect(() => { loadConfigFile().then(() => setConfigReady(true)); }, []);

  if (!configReady) return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-purple-500/30 border-t-purple-400 rounded-full animate-spin" />
    </div>
  );

  switch (mode) {
    case 'gallery-login':
      return <GalleryLogin onLogin={() => setMode('gallery')} onAdminClick={() => setMode('admin-login')} />;
    case 'face-capture':
      return <FaceCapture onCapture={d => { setFaceDescriptor(d); setMode('gallery'); }} onSkip={() => { setFaceDescriptor(null); setMode('gallery'); }} onClose={() => setMode('gallery')} />;
    case 'admin-login':
      return <AdminLogin onLogin={() => setMode('admin')} onBack={() => setMode('gallery-login')} />;
    case 'admin':
      return <AdminPanel onLogout={() => setMode('gallery-login')} />;
    case 'gallery':
      return <Gallery
        faceDescriptor={faceDescriptor}
        onSetFaceDescriptor={setFaceDescriptor}
        onLogout={() => { setFaceDescriptor(null); setMode('gallery-login'); }}
      />;
    default:
      return null;
  }
}
