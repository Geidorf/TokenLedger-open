// 让 `tsc`（include: ["src"]）看到 jest-dom 对 vitest 断言接口的类型增强；
// 运行时匹配器由 tests/setup.ts 注册。
import '@testing-library/jest-dom/vitest';
