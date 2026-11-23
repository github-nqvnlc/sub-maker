import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopBoss } from '@/worker/queues';
import { startSonioxMock, type SonioxMock } from '../mocks/soniox-mock';
import { createAdmin, createUser, resetDb, type TestUser } from './helpers';
import { newProject } from './voice-helpers';
import { createSttJobApi, fixture, postMedia, putSonioxConfig } from './stt-helpers';

/** Cô lập dữ liệu STT giữa hai User (spec 004, Hiến pháp I/V): dữ liệu của người khác → 404 như không tồn tại. */
let mock: SonioxMock;
let a: TestUser;
let b: TestUser;
let projectA: string;
let jobA: string;

beforeAll(async () => {
  mock = await startSonioxMock();
  await resetDb();
  const admin = await createAdmin();
  await putSonioxConfig(admin, mock);
  a = await createUser({ name: 'A' });
  b = await createUser({ name: 'B' });
  projectA = await newProject(a);
  jobA = (await createSttJobApi(a, projectA)).id;
});
afterAll(async () => {
  await mock.close();
  await stopBoss();
});

describe('STT: cô lập giữa User', () => {
  it('B không xem được job của A', async () => {
    expect((await b.client.get(`/api/stt/${jobA}`)).status).toBe(404);
    expect((await a.client.get(`/api/stt/${jobA}`)).status).toBe(200);
  });

  it('B không liệt kê được job trên Project của A', async () => {
    expect((await b.client.get(`/api/projects/${projectA}/stt`)).status).toBe(404);
  });

  it('B không tạo được job trên Project của A', async () => {
    const res = await postMedia(b, projectA, { bytes: await fixture('sample-10s.mp3'), name: 'x.mp3' });
    expect(res.status).toBe(404);
  });

  it('id sai định dạng → 404; chưa đăng nhập → 401', async () => {
    expect((await a.client.get('/api/stt/not-a-uuid')).status).toBe(404);
    const { TestClient } = await import('./helpers');
    expect((await new TestClient().get(`/api/stt/${jobA}`)).status).toBe(401);
  });

  it('User thường không vào được cấu hình Soniox của Admin (ẩn như không tồn tại)', async () => {
    expect((await a.client.get('/api/admin/stt-config')).status).toBe(404);
    expect((await a.client.put('/api/admin/stt-config', { json: { apiKey: 'x' } })).status).toBe(404);
  });
});
