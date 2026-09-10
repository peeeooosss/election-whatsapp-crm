window.API_BASE = window.location.hostname.includes('onrender.com')
  ? ''
  : window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? ''
    : '';