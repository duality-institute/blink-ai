declare module "dompurify" {
  interface SanitizeConfig {
    FORBID_TAGS?: string[];
    FORBID_ATTR?: string[];
    ALLOW_DATA_ATTR?: boolean;
    ALLOWED_TAGS?: string[];
    ALLOWED_ATTR?: string[];
    RETURN_DOM?: boolean;
    RETURN_DOM_FRAGMENT?: boolean;
  }
  interface DOMPurifyStatic {
    sanitize(dirty: string, config?: SanitizeConfig): string;
    setConfig(cfg: SanitizeConfig): void;
    isSupported: boolean;
  }
  const DOMPurify: DOMPurifyStatic;
  export default DOMPurify;
}
