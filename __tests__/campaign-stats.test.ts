import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const db=vi.hoisted(()=>({automation:{findMany:vi.fn()},dmLog:{count:vi.fn()},linkClick:{count:vi.fn()}}));
vi.mock("@/lib/db/client",()=>({prisma:db}));
import { GET } from "@/app/api/internal/campaign-stats/route";
const token="test-only-secret-".repeat(3);
const request=(query:string,auth=token)=>GET(new NextRequest('https://openreply.example/api/internal/campaign-stats?'+query,
  {headers:{authorization:'Bearer '+auth}}));
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('CRON_SECRET',token);vi.stubEnv('CALENDAR_WORKSPACE_IDS','yoyaku=workspace_yoyaku_123,objects=workspace_objects_456');
  db.automation.findMany.mockResolvedValue([{id:'preorder-campaign',publicationKey:'calendar:preorder',postId:'media-preorder'}]);db.dmLog.count.mockResolvedValue(7);db.linkClick.count.mockResolvedValue(3);});
afterEach(()=>vi.unstubAllEnvs());
describe('exact publication campaign statistics',()=>{
  it('refuses missing/invalid credentials, including an unconfigured server',async()=>{
    expect((await request('sku=YY01','wrong')).status).toBe(401);vi.stubEnv('CRON_SECRET','');
    expect((await request('sku=YY01','undefined')).status).toBe(401);expect(db.automation.findMany).not.toHaveBeenCalled();
  });
  it('never chooses the latest campaign for a SKU-only request',async()=>{
    const response=await request('sku=YY01');expect(await response.json()).toEqual({success:true,data:{automation:null,resolution:'scope_required'}});
    expect(db.automation.findMany).not.toHaveBeenCalled();
  });
  it('scopes both lookup and counts to the exact tenant/account/publication',async()=>{
    const response=await request('sku=YY01&workspace_key=yoyaku&account_owner=yoyakurecordstore&publication_key=calendar:preorder');
    const data=await response.json();expect(data.data.automation).toMatchObject({id:'preorder-campaign',dmSent:7,clicks:3});
    expect(db.automation.findMany.mock.calls[0][0]).toMatchObject({take:2,where:{workspaceId:'workspace_yoyaku_123',catnoTag:{equals:'YY01',mode:'insensitive'},
      instagramAccount:{username:{equals:'yoyakurecordstore',mode:'insensitive'}},publicationKey:'calendar:preorder'}});
    expect(db.dmLog.count).toHaveBeenCalledWith({where:{automationId:'preorder-campaign',workspaceId:'workspace_yoyaku_123',status:'SENT'}});
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('requires all supplied publication identities and never sums multiple campaigns',async()=>{
    db.automation.findMany.mockResolvedValue([{id:'one'},{id:'two'}]);
    const response=await request('sku=YY01&workspace_key=yoyaku&account_owner=yoyakurecordstore&post_id=media-1&automation_id=one');
    expect((await response.json()).data.resolution).toBe('ambiguous');expect(db.dmLog.count).not.toHaveBeenCalled();
    expect(db.automation.findMany.mock.calls[0][0].where).toMatchObject({postId:'media-1',id:'one'});
  });
  it('does not fall back to another workspace/account when configuration is missing',async()=>{
    const query='sku=YY01&workspace_key=objects&account_owner=yoyakurecordstore&publication_key=calendar:one';
    expect((await request(query)).status).toBe(400);vi.stubEnv('CALENDAR_WORKSPACE_IDS','');
    expect((await request(query.replace('objects','yoyaku'))).status).toBe(400);expect(db.automation.findMany).not.toHaveBeenCalled();
  });
});
