const getBackendUrls = () => {
  const hostname = window.location.hostname;
  
  // Check if we are running locally
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.');
  
  // Check for environment variables set during build
  const envApiUrl = import.meta.env.VITE_API_URL;
  
  if (envApiUrl) {
    const secure = envApiUrl.startsWith('https');
    const wsProto = secure ? 'wss' : 'ws';
    const cleanHost = envApiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return {
      api: envApiUrl,
      ws: import.meta.env.VITE_WS_URL || `${wsProto}://${cleanHost}`
    };
  }

  // If local dev but no env variable is set
  if (isLocal) {
    return {
      api: `http://${hostname}:8000`,
      ws: `ws://${hostname}:8000`
    };
  }

  // Deployed in production but no environment variable configured
  return {
    api: '',
    ws: '',
    isMissingConfig: true
  };
};

const urls = getBackendUrls();

export const API_URL = urls.api;
export const WS_URL = urls.ws;
export const IS_MISSING_CONFIG = urls.isMissingConfig;
