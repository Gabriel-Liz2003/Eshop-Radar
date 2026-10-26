declare module "web-push" {
  interface PushSubscription {
    endpoint: string;
    expirationTime?: number | null;
    keys: { p256dh: string; auth: string };
  }
  interface VapidKeys { publicKey: string; privateKey: string }
  interface SendOptions {
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
  }
  const webpush: {
    generateVAPIDKeys(): VapidKeys;
    sendNotification(subscription: PushSubscription, payload?: string | Buffer | null, options?: SendOptions): Promise<unknown>;
  };
  export default webpush;
}
