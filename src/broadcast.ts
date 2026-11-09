import {
  GENERATION_BROADCAST_EVENT,
  type GenerationBroadcastPayload,
} from './contract.ts';

export type SendSignal = (
  channel: string,
  payload: GenerationBroadcastPayload,
) => Promise<boolean>;

/**
 * 작업 진행 신호를 Supabase Realtime Broadcast(REST)로 전송
 * - 신호만 보내고 결과, 요청 문구, 코드는 싣지 않음
 * - 채널 이름은 추측할 수 없는 UUID 라 공개 채널로 전송
 * - 전송 실패는 작업을 실패시키지 않음 (화면이 주기적으로 상태를 다시 조회)
 */
export const createBroadcaster = ({
  supabaseUrl,
  publishableKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  publishableKey: string;
  fetchImpl?: typeof fetch;
}): SendSignal => {
  return async (channel, payload) => {
    try {
      const response = await fetchImpl(
        `${supabaseUrl}/realtime/v1/api/broadcast`,
        {
          method: 'POST',
          headers: {
            apikey: publishableKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: [
              {
                topic: channel,
                event: GENERATION_BROADCAST_EVENT,
                payload,
                private: false,
              },
            ],
          }),
          signal: AbortSignal.timeout(5000),
        },
      );

      return response.ok;
    } catch {
      return false;
    }
  };
};
