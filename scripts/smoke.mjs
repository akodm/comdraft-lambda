// 빌드한 번들을 ESM 으로 불러와 진입점이 뜨는지 확인한다 (네트워크·환경 변수 없이).
// node -e 는 전역 require 가 있어 번들 오류를 가리므로 반드시 .mjs 파일로 실행한다.
const { handler } = await import('../dist/index.mjs');
const result = await handler({}, { getRemainingTimeInMillis: () => 1 });

if (result?.outcome !== 'invalid_request') {
  console.error('smoke: 예상하지 못한 결과', result);
  process.exit(1);
}

console.log('smoke: ok');
