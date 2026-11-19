declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    PYTC_GLANCER_ACCOUNTS?: string;
    PYTC_GLANCER_PASSWORD?: string;
    PYTC_GLANCER_PUBLIC_STATE?: string;
    PYTC_GLANCER_SOURCES?: string;
    PYTC_GLANCER_VIEWER_ORIGINS?: string;
    PYTC_GLANCER_DEFAULT_VIEWER_URL?: string;
    PYTC_GLANCER_TLDRAW_LICENSE_KEY?: string;
    GCS_SA_KEY?: string;
  }
}
