import { useState, useEffect, useCallback, useRef } from 'react';
import * as faceapi from '@vladmandic/face-api';
import {
  Lock, Eye, EyeOff, Plus, Trash2, FolderOpen, Link2,
  Grid3X3, LayoutGrid,
  X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut, RotateCw,
  LogOut, AlertCircle, Search, Images, ShieldCheck, Upload,
  RefreshCw, Settings, KeyRound, Save, ExternalLink, Shield,
  Layers, Camera, Sparkles, ImageIcon, Aperture, ScanFace, UserCheck, UploadCloud,
  Heart, FileDown, FileUp
} from 'lucide-react';

/* ═══════════════════ TYPES ═══════════════════ */
interface GDriveFolder { id: string; name: string; folderId: string; link: string; }
interface Photo { id: string; fileId: string; name: string; thumb: string; full: string; dl: string; folder: string; }
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

/** Fetch ALL files using Google Drive API v3 with pagination (needs API key) */
async function fetchViaApi(folderId: string, apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  do {
    const q = `'${folderId}' in parents and trashed=false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType)');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Drive API error:', res.status, errBody);
      throw new Error(`API error ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    if (data.error) {
      console.error('Drive API returned error:', data.error);
      throw new Error(data.error.message || 'API error');
    }
    for (const f of (data.files || [])) {
      // Accept any file whose mimeType starts with "image/"
      if (f.mimeType && f.mimeType.startsWith('image/')) {
        ids.push(f.id);
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  console.log(`Drive API: fetched ${ids.length} images from folder ${folderId}`);
  return ids;
}

/** Fallback: scrape HTML page via CORS proxy (limited to ~50-100 files) */
async function fetchViaScrape(folderId: string): Promise<string[]> {
  const ids = new Set<string>(); const driveUrl = `https://drive.google.com/drive/folders/${folderId}`;
  const proxies = [(u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`];
  let html = ''; for (const proxy of proxies) { try { const res = await fetch(proxy(driveUrl)); if (res.ok) { html = await res.text(); if (html.length > 500) break; } } catch { continue; } }
  if (!html) throw new Error('Could not fetch folder'); let m;
  const r1 = /data-id="([a-zA-Z0-9_-]{20,})"/g; while ((m = r1.exec(html))) ids.add(m[1]);
  const r2 = /\/file\/d\/([a-zA-Z0-9_-]{20,})/g; while ((m = r2.exec(html))) ids.add(m[1]);
  const r3 = /\["([a-zA-Z0-9_-]{20,})"[^\]]*?"image\/(jpeg|png|gif|webp|bmp|svg\+xml|heic|heif|tiff)"/g; while ((m = r3.exec(html))) ids.add(m[1]);
  // Also extract IDs from JS data arrays: ,["ID", or ,"ID",
  const r4 = /[,\[]\s*"([a-zA-Z0-9_-]{25,45})"\s*[,\]]/g; while ((m = r4.exec(html))) { const c = m[1]; if (c !== folderId && /[a-z]/.test(c) && /[0-9A-Z]/.test(c) && !c.includes('__') && !/^[a-z]+$/.test(c) && !/^[A-Z_]+$/.test(c)) ids.add(c); }
  ids.delete(folderId); return Array.from(ids);
}

let _lastApiStatus = '';
function getLastApiStatus() { return _lastApiStatus; }

async function fetchFolderFileIds(folderId: string): Promise<string[]> {
  const apiKey = getApiKey();
  if (apiKey) {
    _lastApiStatus = 'using-api';
    try {
      const result = await fetchViaApi(folderId, apiKey);
      if (result.length > 0) {
        _lastApiStatus = `api-ok:${result.length}`;
        return result;
      }
      _lastApiStatus = 'api-returned-0';
      console.warn('API returned 0 images, trying scrape fallback');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      _lastApiStatus = `api-error:${msg}`;
      console.error('API FAILED:', msg);
    }
  } else {
    _lastApiStatus = 'no-api-key';
  }
  const scrapeResult = await fetchViaScrape(folderId);
  _lastApiStatus += `|scrape:${scrapeResult.length}`;
  return scrapeResult;
}

function loadFolders(): GDriveFolder[] { if (FILE_CONFIG?.folders?.length) return FILE_CONFIG.folders; try { return JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]'); } catch { return []; } }
function saveFolders(f: GDriveFolder[]) { localStorage.setItem(FOLDERS_KEY, JSON.stringify(f)); }
function loadImage(src: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error('Failed')); img.src = src; }); }

/* ═══════════════ BG PARTICLES ═══════════════ */
function BgParticles() {
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
      <div className="absolute -top-20 -left-20 w-[500px] h-[500px] rounded-full bg-purple-600/[0.07] blur-[150px] grad-move" />
      <div className="absolute -bottom-20 -right-20 w-[400px] h-[400px] rounded-full bg-indigo-600/[0.06] blur-[130px] grad-move" style={{ animationDelay: '3s' }} />
      <div className="absolute top-1/3 right-1/4 w-[300px] h-[300px] rounded-full bg-pink-600/[0.04] blur-[120px] grad-move" style={{ animationDelay: '5s' }} />
      {Array.from({ length: 20 }).map((_, i) => (<div key={i} className="absolute rounded-full bg-white/[0.03]" style={{ width: `${2 + Math.random() * 4}px`, height: `${2 + Math.random() * 4}px`, top: `${Math.random() * 100}%`, left: `${Math.random() * 100}%`, animation: `float ${4 + Math.random() * 6}s ease-in-out infinite`, animationDelay: `${Math.random() * 5}s` }} />))}
    </div>
  );
}

/* ═══════════════ LOADER ═══════════════ */
const LOADING_TIPS = ["Fetching your memories…", "Unwrapping your photo collection…", "Almost there, hang tight…", "Gathering pixels from the cloud…", "Loading beautiful moments…", "Preparing your gallery experience…", "Sorting through your treasures…", "Bringing your photos to life…", "Just a moment, magic is happening…", "Dusting off the photo albums…"];
const _SCAN_TIPS = ["Analyzing faces in your photos…", "Looking for your face in the gallery…", "Matching facial features…", "AI is doing its magic…", "Comparing face descriptors…", "Finding photos with you in them…", "Almost done, recognizing faces…", "Scanning gallery for matches…"];
function useCyclingTip(tips: string[], interval = 3000) { const [i, setI] = useState(0); useEffect(() => { const t = setInterval(() => setI(n => (n + 1) % tips.length), interval); return () => clearInterval(t); }, [tips, interval]); return tips[i]; }

function FancyLoader({ tips, progress, total, label }: { tips: string[]; progress: number; total: number; label: string }) {
  const [tipIdx, setTipIdx] = useState(0);
  useEffect(() => { const t = setInterval(() => setTipIdx(i => (i + 1) % tips.length), 2800); return () => clearInterval(t); }, [tips]);
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  return (
    <div className="fixed inset-0 z-40 bg-dark-900 flex items-center justify-center"><BgParticles />
      <div className="relative flex flex-col items-center anim-scale-in z-10">
        <div className="relative w-40 h-40 mb-10">
          <div className="absolute inset-0 flex items-center justify-center"><div className="absolute w-32 h-32 rounded-full border border-purple-500/10 spin-slow" /><div className="absolute w-24 h-24 rounded-full border border-indigo-500/10 spin-slow" style={{ animationDirection: 'reverse', animationDuration: '8s' }} /><div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-600 via-violet-600 to-indigo-600 flex items-center justify-center shadow-2xl shadow-purple-600/40 anim-float anim-glow"><Camera className="w-10 h-10 text-white drop-shadow-lg" /></div></div>
          <div className="absolute inset-0 flex items-center justify-center"><div className="anim-orbit" style={{ animationDuration: '3s' }}><div className="w-9 h-9 rounded-xl bg-pink-500/20 backdrop-blur border border-pink-500/20 flex items-center justify-center shadow-lg shadow-pink-500/10"><ImageIcon className="w-4 h-4 text-pink-400" /></div></div></div>
          <div className="absolute inset-0 flex items-center justify-center"><div className="anim-orbit" style={{ animationDuration: '4.5s', animationDelay: '-1.5s' }}><div className="w-9 h-9 rounded-xl bg-violet-500/20 backdrop-blur border border-violet-500/20 flex items-center justify-center shadow-lg shadow-violet-500/10"><Sparkles className="w-4 h-4 text-violet-400" /></div></div></div>
          <div className="absolute inset-0 flex items-center justify-center"><div className="anim-orbit" style={{ animationDuration: '6s', animationDelay: '-3s' }}><div className="w-9 h-9 rounded-xl bg-cyan-500/20 backdrop-blur border border-cyan-500/20 flex items-center justify-center shadow-lg shadow-cyan-500/10"><Aperture className="w-4 h-4 text-cyan-400" /></div></div></div>
        </div>
        <div className="w-64 mb-6"><div className="h-2 bg-white/[0.04] rounded-full overflow-hidden backdrop-blur"><div className="h-full bg-gradient-to-r from-purple-500 via-pink-500 to-indigo-500 rounded-full transition-all duration-700 ease-out grad-move" style={{ width: `${Math.max(pct, 10)}%` }} /></div>{total > 0 && <p className="text-white/25 text-[10px] text-center mt-2 font-mono tabular-nums">{progress} / {total} {label}</p>}</div>
        <div className="h-7 relative w-80 overflow-hidden">{tips.map((tip, i) => (<p key={i} className="absolute inset-0 flex items-center justify-center text-white/40 text-[13px] text-center transition-all duration-500 font-light" style={{ opacity: i === tipIdx ? 1 : 0, transform: i === tipIdx ? 'translateY(0)' : 'translateY(14px)' }}>{tip}</p>))}</div>
        <div className="flex gap-2 mt-6">{[0, 1, 2].map(i => (<div key={i} className="w-2 h-2 rounded-full bg-gradient-to-br from-purple-400 to-pink-400" style={{ animation: 'pulse3 1.4s ease-in-out infinite', animationDelay: `${i * 0.25}s` }} />))}</div>
      </div>
    </div>
  );
}

/* ═══════════════ FACE CAPTURE ═══════════════ */
function FaceCapture({ onCapture, onSkip }: { onCapture: (d: Float32Array) => void; onSkip: () => void }) {
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

  // Load models
  useEffect(() => {
    (async () => {
      try {
        setModelLoading(true);
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
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
      const d = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!d) {
        setError('No face detected. Make sure your face is clearly visible and well-lit.');
        setProcessing(false);
        return;
      }
      onCapture(d.descriptor);
    } catch (e) {
      console.error('Face detect error:', e);
      setError('Detection failed. Try a different photo.');
    }
    setProcessing(false);
  };

  useEffect(() => () => stopCamera(), []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-900 p-4 relative overflow-hidden"><BgParticles />
      <div className="relative z-10 w-full max-w-lg"><div className="glass-strong rounded-[28px] p-7 shadow-2xl shadow-black/50 anim-scale-in">
        {/* Header */}
        <div className="flex flex-col items-center mb-7">
          <div className="relative mb-4">
            <div className="w-20 h-20 rounded-[22px] bg-gradient-to-br from-pink-500 via-rose-500 to-violet-600 flex items-center justify-center shadow-xl shadow-pink-600/30 anim-glow">
              <ScanFace className="w-10 h-10 text-white drop-shadow" />
            </div>
            <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-md animate-pulse">
              <Sparkles className="w-3 h-3 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Find Your Photos</h1>
          <p className="text-white/40 text-sm mt-1 text-center max-w-xs leading-relaxed">
            {isMobile ? 'Take a selfie or pick a photo from your gallery' : 'Snap a selfie or upload your photo — AI will find you'}
          </p>
        </div>

        {/* Model loading */}
        {modelLoading && (
          <div className="flex flex-col items-center py-10">
            <div className="relative w-12 h-12 mb-4">
              <div className="absolute inset-0 rounded-full border-2 border-purple-500/20" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-400 animate-spin" />
            </div>
            <p className="text-white/40 text-sm">Initializing AI…</p>
            <p className="text-white/20 text-xs mt-1">First time may take a moment</p>
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
                <Camera className="w-5 h-5 text-pink-400 group-hover:scale-110 transition-transform" /> Take Selfie
              </button>
              {/* Upload from gallery */}
              <button onClick={() => uploadRef.current?.click()} disabled={!modelsLoaded}
                className="py-3.5 glass rounded-2xl text-white text-sm font-medium transition-all hover:bg-white/[0.08] flex items-center justify-center gap-2 disabled:opacity-30 group">
                <UploadCloud className="w-5 h-5 text-violet-400 group-hover:scale-110 transition-transform" /> Upload
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
                className="w-full py-4 rounded-2xl font-semibold text-[15px] text-white bg-gradient-to-r from-pink-600 via-rose-600 to-violet-600 hover:from-pink-500 hover:via-rose-500 hover:to-violet-500 shadow-xl shadow-pink-600/20 transition-all active:scale-[.97] disabled:opacity-50 flex items-center justify-center gap-2.5 grad-move">
                {processing
                  ? <><span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Detecting face…</>
                  : <><UserCheck className="w-5 h-5" />Find My Photos</>
                }
              </button>
            )}

            {/* Skip */}
            <button onClick={onSkip}
              className="w-full py-3.5 rounded-2xl text-sm font-medium text-white/50 hover:text-white glass hover:bg-white/[0.06] transition-all active:scale-[.98] flex items-center justify-center gap-2.5">
              <Images className="w-5 h-5" /> Skip — View All Photos
            </button>
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
    <div className="min-h-screen flex items-center justify-center bg-dark-900 p-4 relative overflow-hidden"><BgParticles />
      <div className="relative z-10 w-full max-w-sm"><form onSubmit={submit} className="glass-strong rounded-[28px] p-8 shadow-2xl shadow-black/50 anim-scale-in">
        <div className="flex flex-col items-center mb-9"><div className="relative mb-4"><div className="w-[82px] h-[82px] rounded-[22px] bg-gradient-to-br from-purple-600 via-violet-600 to-indigo-600 flex items-center justify-center shadow-xl shadow-purple-600/30 anim-glow rotate-2 hover:rotate-0 transition-transform duration-500"><Images className="w-10 h-10 text-white drop-shadow" /></div><div className="absolute -bottom-2 -right-2 w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-lg"><ShieldCheck className="w-4 h-4 text-white" /></div></div><h1 className="text-2xl font-bold text-white tracking-tight">Photo Gallery</h1><p className="text-white/35 text-sm mt-1">Enter password to continue</p></div>
        <div className="space-y-3.5">
          <div className="relative group"><Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-white/25 group-focus-within:text-purple-400 transition-colors" /><input autoFocus type={show ? 'text' : 'password'} value={pw} onChange={e => { setPw(e.target.value); setErr(''); }} placeholder="Enter password" className="w-full pl-11 pr-12 py-3.5 bg-white/[0.04] border border-white/[0.08] rounded-2xl text-white text-[15px] placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500/30 transition-all" /><button type="button" onClick={() => setShow(!show)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50 transition">{show ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}</button></div>
          {err && <p className="text-red-400 text-xs flex items-center gap-2 bg-red-500/10 border border-red-500/15 rounded-xl px-4 py-3"><AlertCircle className="w-4 h-4 shrink-0" />{err}</p>}
          <button type="submit" disabled={busy || !stored} className="w-full py-3.5 rounded-2xl font-semibold text-[15px] text-white bg-gradient-to-r from-purple-600 via-violet-600 to-indigo-600 hover:from-purple-500 hover:via-violet-500 hover:to-indigo-500 shadow-xl shadow-purple-600/20 transition-all active:scale-[.97] disabled:opacity-40 grad-move">{busy ? <span className="flex items-center justify-center gap-2"><span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /></span> : 'Enter Gallery'}</button>
        </div>
        <button type="button" onClick={onAdminClick} className="mt-7 w-full text-center text-white/15 hover:text-white/40 text-xs transition flex items-center justify-center gap-1.5"><Settings className="w-3.5 h-3.5" /> Admin</button>
      </form>
      <p className="text-center text-white/[0.08] text-[10px] mt-6 flex items-center justify-center gap-1">Made with <Heart className="w-2.5 h-2.5" /> for memories</p></div>
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
          <p className="text-white/30 text-[11px] mb-3 leading-relaxed"><strong className="text-white/50">Required for 1000+ photos.</strong> Without an API key, only ~50-100 photos load per folder. Get a free key from <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-cyan-400/80 underline underline-offset-2">Google Cloud Console</a> (enable Drive API).</p>
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
  const [downloading, setDownloading] = useState(false);
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
    setDownloading(true);
    await downloadPhoto(photo);
    setDownloading(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/[0.97] backdrop-blur-xl flex flex-col anim-scale-in">
      <div className="flex items-center justify-between px-4 py-3 shrink-0 bg-gradient-to-b from-black/60 to-transparent"><span className="text-white/50 text-sm font-mono tabular-nums"><span className="text-white font-semibold">{index + 1}</span><span className="text-white/20"> / </span>{photos.length}</span><div className="flex items-center gap-1">{[{ icon: ZoomIn, fn: () => setZoom(z => Math.min(z + .25, 4)) }, { icon: ZoomOut, fn: () => setZoom(z => Math.max(z - .25, .5)) }, { icon: RotateCw, fn: () => setRot(r => r + 90) }].map((b, i) => (<button key={i} onClick={b.fn} className="p-2.5 text-white/30 hover:text-white hover:bg-white/10 rounded-xl transition"><b.icon className="w-5 h-5" /></button>))}<button onClick={handleDownload} disabled={downloading} className="p-2.5 text-white/30 hover:text-white hover:bg-white/10 rounded-xl transition disabled:opacity-40">{downloading ? <span className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin block" /> : <Download className="w-5 h-5" />}</button><div className="w-px h-6 bg-white/10 mx-1" /><button onClick={onClose} className="p-2.5 text-white/30 hover:text-white hover:bg-white/10 rounded-xl transition"><X className="w-5 h-5" /></button></div></div>
      <div className="flex-1 flex items-center justify-center relative overflow-hidden select-none px-4"><button onClick={prev} disabled={index === 0} className="absolute left-3 z-10 p-3 rounded-2xl bg-white/5 hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-0 transition-all backdrop-blur"><ChevronLeft className="w-7 h-7" /></button>{loading && !imgErr && <div className="absolute inset-0 flex items-center justify-center"><div className="w-10 h-10 border-2 border-white/10 border-t-purple-400 rounded-full animate-spin" /></div>}{imgErr ? <div className="flex flex-col items-center gap-4 text-white/25"><Images className="w-14 h-14" /><p className="text-sm">Could not load</p><button onClick={handleDownload} className="text-xs text-purple-400 underline underline-offset-2 hover:text-purple-300 transition">Download Original</button></div> : <img src={src} alt={photo.name} draggable={false} className="max-w-full max-h-full object-contain transition-all duration-300 rounded-lg" style={{ transform: `scale(${zoom}) rotate(${rot}deg)`, opacity: loading ? 0 : 1 }} onLoad={() => setLoading(false)} onError={handleError} referrerPolicy="no-referrer" />}<button onClick={next} disabled={index === photos.length - 1} className="absolute right-3 z-10 p-3 rounded-2xl bg-white/5 hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-0 transition-all backdrop-blur"><ChevronRight className="w-7 h-7" /></button></div>
      <div className="bg-gradient-to-t from-black/60 to-transparent pt-2 pb-3"><div className="text-center mb-2"><span className="text-white/30 text-[11px] truncate block max-w-sm mx-auto">{photo.name}</span></div><div ref={thumbRef} className="flex items-center justify-start overflow-x-auto gap-2 px-4">{photos.map((p, i) => (<button key={`${p.id}-${i}`} data-idx={i} onClick={() => { onNav(i); reset(); }} className={`shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition-all duration-200 ${i === index ? 'border-purple-500 ring-2 ring-purple-500/30 scale-110' : 'border-transparent opacity-35 hover:opacity-60'}`}><img src={p.thumb} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" /></button>))}</div></div>
    </div>
  );
}

/* ═══════════════ GALLERY ═══════════════ */
function Gallery({ faceDescriptor, onLogout }: { faceDescriptor: Float32Array | null; onLogout: () => void }) {
  const folders = loadFolders();
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]); const [matchedPhotos, setMatchedPhotos] = useState<Photo[] | null>(null);
  const [loadingPhotos, setLoadingPhotos] = useState(true); const [scanning, setScanning] = useState(false); const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState<number | null>(null); const [layout, setLayout] = useState<'grid' | 'masonry'>('grid'); const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<Set<string>>(new Set()); const [failed, setFailed] = useState<Set<string>>(new Set());
  const [foldersLoaded, setFoldersLoaded] = useState(0); const [scanProgress, setScanProgress] = useState(0); const [scanTotal, setScanTotal] = useState(0); const [showAll, setShowAll] = useState(false);
  const scanTip = useCyclingTip(_SCAN_TIPS);

  const loadPhotos = useCallback(async () => {
    setLoadingPhotos(true); setError(''); setLoaded(new Set()); setFailed(new Set()); setAllPhotos([]); setMatchedPhotos(null); setFoldersLoaded(0);
    try {
      const all: Photo[] = [];
      const errors: string[] = [];
      for (const f of folders) {
        try {
          const ids = await fetchFolderFileIds(f.folderId);
          console.log(`Folder "${f.name}": ${ids.length} images found`);
          all.push(...ids.map((fid, i) => ({
            id: fid, fileId: fid,
            name: `${f.name} — Photo ${i + 1}`,
            thumb: makeThumb(fid), full: makeFull(fid), dl: makeDl(fid),
            folder: f.name,
          })));
        } catch (e) {
          console.error(`Error loading folder "${f.name}":`, e);
          errors.push(f.name);
        }
        setFoldersLoaded(n => n + 1);
      }
      setAllPhotos(all);
      console.log(`Total photos loaded: ${all.length} | API status: ${getLastApiStatus()}`);
      if (!all.length && folders.length > 0) {
        setError(`No images found.${errors.length ? ` Failed folders: ${errors.join(', ')}.` : ''} Make sure folders are shared publicly and API key is valid. [${getLastApiStatus()}]`);
      }
      if (!folders.length) setError('No albums configured. Contact admin.');
    } catch (e) {
      console.error('loadPhotos error:', e);
      setError('Something went wrong loading photos.');
    }
    setLoadingPhotos(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  // Face scan — fast parallel batched processing
  useEffect(() => {
    if (loadingPhotos || !faceDescriptor || allPhotos.length === 0) return;
    let cancelled = false;
    const THRESHOLD = 0.55;
    const BATCH_SIZE = 8; // process 8 photos in parallel
    const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 });

    // Use small thumbnails for scanning (w150 instead of w400)
    const makeScanUrl = (fid: string) => `https://lh3.googleusercontent.com/d/${fid}=w160`;

    // Scan a single photo — returns the photo if face matches, null otherwise
    const scanOne = async (photo: Photo): Promise<Photo | null> => {
      try {
        const img = await loadImage(makeScanUrl(photo.fileId));
        const dets = await faceapi.detectAllFaces(img, detectorOptions).withFaceLandmarks().withFaceDescriptors();
        for (const d of dets) {
          if (faceapi.euclideanDistance(faceDescriptor, d.descriptor) < THRESHOLD) return photo;
        }
      } catch { /* skip */ }
      return null;
    };

    (async () => {
      setScanning(true);
      setScanTotal(allPhotos.length);
      setScanProgress(0);
      const matches: Photo[] = [];

      // Process in batches of BATCH_SIZE
      for (let i = 0; i < allPhotos.length; i += BATCH_SIZE) {
        if (cancelled) break;
        const batch = allPhotos.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(scanOne));
        for (const r of results) {
          if (r) matches.push(r);
        }
        setScanProgress(Math.min(i + BATCH_SIZE, allPhotos.length));
        // Update matches progressively so user sees results appearing
        setMatchedPhotos([...matches]);
      }

      if (!cancelled) {
        setMatchedPhotos(matches);
        setScanning(false);
      }
    })();

    return () => { cancelled = true; };
  }, [loadingPhotos, faceDescriptor, allPhotos]);

  const displayPhotos = (!faceDescriptor || showAll) ? allPhotos : (matchedPhotos ?? []);
  const isReady = !loadingPhotos;
  const visible = displayPhotos.filter(p => !failed.has(p.id)).filter(p => !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.folder.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="min-h-screen bg-dark-900">
      {loadingPhotos && <FancyLoader tips={LOADING_TIPS} progress={foldersLoaded} total={folders.length} label="albums loaded" />}
      {isReady && (<>
        {/* Scanning progress bar — inline, not blocking */}
        {scanning && faceDescriptor && (
          <div className="fixed top-0 left-0 right-0 z-40">
            <div className="h-1 bg-white/[0.03]">
              <div className="h-full bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500 transition-all duration-300 ease-out grad-move"
                style={{ width: `${scanTotal > 0 ? Math.round((scanProgress / scanTotal) * 100) : 0}%` }} />
            </div>
            <div className="glass-strong border-b border-white/5 px-4 py-2 flex items-center justify-center gap-3">
              <span className="w-4 h-4 border-2 border-purple-400/30 border-t-purple-400 rounded-full animate-spin" />
              <span className="text-white/50 text-xs hidden sm:inline">{scanTip}</span>
              <span className="text-white/50 text-xs sm:hidden">Scanning… <span className="text-white/70 font-mono">{scanProgress}/{scanTotal}</span></span>
              <span className="text-emerald-400/70 text-xs font-medium">{matchedPhotos?.length || 0} found</span>
            </div>
          </div>
        )}
        <header className={`sticky top-0 z-30 glass-strong border-b border-white/[0.04] ${scanning ? 'mt-[52px]' : ''}`}><div className="max-w-[1440px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-4"><div className="flex items-center gap-3 min-w-0"><div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center shrink-0 shadow-lg shadow-purple-800/20 anim-glow"><Images className="w-[18px] h-[18px] text-white" /></div><div className="min-w-0"><h2 className="text-white font-semibold text-[15px] truncate">{faceDescriptor && !showAll ? '🎯 Your Photos' : '📸 Gallery'}</h2><p className="text-white/30 text-[11px]">{faceDescriptor && !showAll ? `${visible.length} with your face` : `${visible.length} photos`}</p></div></div><div className="flex items-center gap-2">{faceDescriptor && <button onClick={() => setShowAll(v => !v)} className={`hidden sm:flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all ${showAll ? 'bg-pink-600/20 text-pink-300 border border-pink-500/20' : 'glass text-white/50 hover:text-white/80'}`}>{showAll ? <><ScanFace className="w-3.5 h-3.5" />My Photos</> : <><Layers className="w-3.5 h-3.5" />All Photos</>}</button>}<div className="relative hidden sm:block"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…" className="pl-9 pr-4 py-2 w-48 glass rounded-xl text-white text-xs placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-purple-500/30" /></div><div className="flex glass rounded-xl p-0.5"><button onClick={() => setLayout('grid')} className={`p-2 rounded-lg transition ${layout === 'grid' ? 'bg-purple-600 text-white shadow-md' : 'text-white/30 hover:text-white/60'}`}><Grid3X3 className="w-4 h-4" /></button><button onClick={() => setLayout('masonry')} className={`p-2 rounded-lg transition ${layout === 'masonry' ? 'bg-purple-600 text-white shadow-md' : 'text-white/30 hover:text-white/60'}`}><LayoutGrid className="w-4 h-4" /></button></div><button onClick={loadPhotos} className="p-2 text-white/25 hover:text-white glass rounded-xl transition"><RefreshCw className="w-4 h-4" /></button><button onClick={onLogout} className="p-2 text-white/25 hover:text-red-400 glass rounded-xl transition"><LogOut className="w-[18px] h-[18px]" /></button></div></div></header>
        <main className="max-w-[1440px] mx-auto px-4 md:px-6 py-6">
          {faceDescriptor && !error && <button onClick={() => setShowAll(v => !v)} className={`sm:hidden w-full mb-5 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold transition-all ${showAll ? 'bg-pink-600/20 text-pink-300 border border-pink-500/20' : 'glass text-white/50'}`}>{showAll ? <><ScanFace className="w-4 h-4" />Show My Photos Only</> : <><Layers className="w-4 h-4" />Show All Photos</>}</button>}
          {error && <div className="flex flex-col items-center py-32 anim-fade-up"><Images className="w-14 h-14 text-white/[0.06] mb-4" /><p className="text-white/35 text-sm text-center max-w-sm">{error}</p><button onClick={loadPhotos} className="mt-5 px-5 py-2.5 glass text-purple-300 text-xs rounded-xl transition hover:bg-white/5">Retry</button></div>}
          {!error && faceDescriptor && !showAll && matchedPhotos && matchedPhotos.length === 0 && <div className="flex flex-col items-center py-32 anim-fade-up"><div className="w-20 h-20 rounded-3xl glass flex items-center justify-center mb-5"><ScanFace className="w-10 h-10 text-white/10" /></div><p className="text-white/35 text-base font-medium">No photos with your face found</p><p className="text-white/20 text-sm mt-1 mb-6">Try a different selfie or browse everything</p><button onClick={() => setShowAll(true)} className="px-6 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-semibold rounded-2xl shadow-xl shadow-purple-700/20 transition active:scale-[.97] flex items-center gap-2 grad-move"><Layers className="w-5 h-5" />Show All Photos</button></div>}
          {!error && visible.length > 0 && layout === 'grid' && <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">{visible.map((p, i) => (<button key={`${p.id}-${i}`} onClick={() => setLightbox(i)} className="group relative aspect-square rounded-2xl overflow-hidden bg-dark-700/50 border border-white/[0.04] hover:border-purple-500/30 transition-all duration-500 hover:shadow-xl hover:shadow-purple-500/10 hover:scale-[1.04] anim-card-in" style={{ animationDelay: `${Math.min(i * 40, 800)}ms` }}>{!loaded.has(p.id) && !failed.has(p.id) && <div className="absolute inset-0 shimmer" />}<img src={p.thumb} alt={p.name} loading="lazy" referrerPolicy="no-referrer" className={`w-full h-full object-cover transition-all duration-700 group-hover:scale-110 ${loaded.has(p.id) ? 'opacity-100' : 'opacity-0'}`} onLoad={() => setLoaded(s => new Set(s).add(p.id))} onError={() => setFailed(s => new Set(s).add(p.id))} /><div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" /><div className="absolute bottom-0 left-0 right-0 p-2.5 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0"><p className="text-white text-[11px] truncate font-medium">{p.name}</p></div></button>))}</div>}
          {!error && visible.length > 0 && layout === 'masonry' && <div className="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-2.5 [&>button]:mb-2.5">{visible.map((p, i) => (<button key={`${p.id}-${i}`} onClick={() => setLightbox(i)} className="group relative w-full rounded-2xl overflow-hidden bg-dark-700/50 border border-white/[0.04] hover:border-purple-500/30 transition-all duration-500 hover:shadow-xl hover:shadow-purple-500/10 break-inside-avoid block anim-card-in" style={{ animationDelay: `${Math.min(i * 40, 800)}ms` }}>{!loaded.has(p.id) && !failed.has(p.id) && <div className="w-full pt-[75%] shimmer" />}<img src={p.thumb} alt={p.name} loading="lazy" referrerPolicy="no-referrer" className={`w-full h-auto transition-all duration-700 group-hover:scale-105 ${loaded.has(p.id) ? 'opacity-100' : 'opacity-0'}`} onLoad={() => setLoaded(s => new Set(s).add(p.id))} onError={() => setFailed(s => new Set(s).add(p.id))} /><div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" /></button>))}</div>}
          {!error && displayPhotos.length > 0 && !visible.length && query && <div className="flex flex-col items-center py-32"><Search className="w-12 h-12 text-white/[0.06] mb-4" /><p className="text-white/35 text-sm">No results for "{query}"</p></div>}
        </main>
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
    case 'gallery-login': return <GalleryLogin onLogin={() => setMode('face-capture')} onAdminClick={() => setMode('admin-login')} />;
    case 'face-capture': return <FaceCapture onCapture={d => { setFaceDescriptor(d); setMode('gallery'); }} onSkip={() => { setFaceDescriptor(null); setMode('gallery'); }} />;
    case 'admin-login': return <AdminLogin onLogin={() => setMode('admin')} onBack={() => setMode('gallery-login')} />;
    case 'admin': return <AdminPanel onLogout={() => setMode('gallery-login')} />;
    case 'gallery': return <Gallery faceDescriptor={faceDescriptor} onLogout={() => { setFaceDescriptor(null); setMode('gallery-login'); }} />;
    default: return null;
  }
}
