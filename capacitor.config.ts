import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.stimilon.vampireknights',
  appName: 'Vampire Knights',
  webDir: 'dist',
  // Matches the body background in src/ui/style.css so the letterbox and any
  // pre-paint flash are the same black as the game's own frame.
  backgroundColor: '#05060a',
  ios: {
    // The canvas letterboxes itself; WKWebView must never add its own insets.
    contentInset: 'never',
  },
};

export default config;
