import type { Pt, RuleSet, ValidationResult } from '../model';
import { useStore } from '../store/store';

const TYPE_LABELS: Record<string, string> = {
  TRAVEL_EXCEED: '疏散距离超限',
  DEADEND_EXCEED: '袋形走道超限',
  EXIT_COUNT: '安全出口数量',
  EXIT_NOT_CONNECTED: '出口未连通',
  EXIT_CAPACITY: '出口超载',
  EXIT_WIDTH: '疏散宽度不足',
  EXIT_WIDTH_NARROW: '出口宽度不足',
  COVERAGE_UNCOVERED: '灭火器覆盖不足',
  CHECK_OVERDUE: '检查过期',
  CHECK_MISSING: '缺检查记录',
  FACILITY_DEFECT: '设施缺陷',
  NO_DOOR: '房间无门',
};

type Props = {
  floorId: string;
  result: ValidationResult | null;
  busy: boolean;
  rules: RuleSet;
  onLocate: (pt: Pt | null, sel?: { type: 'room' | 'facility'; id: string }) => void;
};

export function ValidationPanel({ floorId, result, busy, rules, onLocate }: Props) {
  const floor = useStore((s) => s.floors[floorId]);

  const locateCoverage = (pt: Pt) => onLocate(pt);

  return (
    <section className="validation">
      <h4>
        合规校验 {busy && <span className="spinner">校验中…</span>}
      </h4>
      {!result && !busy && <p className="hint">布置房间与设施后自动校验</p>}
      {result && (
        <>
          <div className={`verdict ${result.pass ? 'pass' : 'fail'}`}>
            {result.pass ? '✔ 当前规则下合规' : '✘ 存在不合规项'}
            <span className="hint"> 规则：{result.rulesSnapshot.buildingKind} v{result.rulesSnapshot.version}</span>
          </div>
          <div className="statgrid">
            <div className="stat">
              <label>疏散最远（沿路径）</label>
              <b className={result.travelWorstM != null && result.travelWorstM > rules.maxTravelDistanceM ? 'bad' : ''}>
                {result.travelWorstM != null ? `${result.travelWorstM.toFixed(1)}m` : '—'}
              </b>
              <span>限值 {rules.maxTravelDistanceM}m</span>
              {result.travelWorstPoint && (
                <button className="ghost" onClick={() => onLocate(result.travelWorstPoint!)}>定位</button>
              )}
            </div>
            <div className="stat">
              <label>袋形走道（死端）</label>
              <b className={result.deadEndM != null && result.deadEndM > rules.deadEndDistanceM ? 'bad' : ''}>
                {result.deadEndM != null ? `${result.deadEndM.toFixed(1)}m` : '—'}
              </b>
              <span>限值 {rules.deadEndDistanceM}m</span>
            </div>
            <div className="stat">
              <label>灭火器未覆盖</label>
              <b className={result.coverage && !result.coverage.pass ? 'bad' : ''}>
                {result.coverage ? `${result.coverage.uncoveredM2.toFixed(1)}㎡` : '—'}
              </b>
              <span>半径 {rules.extinguisherRadiusM}m</span>
              {result.coverage && result.coverage.samples.length > 0 && (
                <button className="ghost" onClick={() => locateCoverage(result.coverage!.samples[0])}>看未覆盖点</button>
              )}
            </div>
            <div className="stat">
              <label>楼层人数（实填+估算）</label>
              <b className="">
                {result.occupancy.occupants}
                {result.occupancy.estimated > 0 && <span className="hint"> 人（约 {result.occupancy.estimated} 为估算）</span>}
                {result.occupancy.estimated === 0 && <span className="hint"> 人（全部实填）</span>}
              </b>
              <span>按用途密度回填留空房间</span>
            </div>
            <div className="stat">
              <label>安全出口</label>
              <b className={result.exits.present < result.exits.required ? 'bad' : ''}>
                {result.exits.present}/{result.exits.required}
              </b>
              <span>现有/需要</span>
            </div>
            <div className="stat">
              <label>疏散总净宽度</label>
              <b className={result.occupancy.availableWidthM < result.occupancy.requiredWidthM ? 'bad' : ''}>
                {result.occupancy.availableWidthM.toFixed(2)}/{result.occupancy.requiredWidthM.toFixed(2)}m
              </b>
              <span>现有/需要（{result.occupancy.widthPer100M.toFixed(2)}m/百人）</span>
            </div>
            {result.exitLoads.length > 0 && (
              <div className="stat exitloads" style={{ gridColumn: '1 / -1' }}>
                <label>各出口分流（最近出口分配人数 / 按净宽可过人数）</label>
                {result.exitLoads.map((l) => (
                  <button
                    key={l.facilityId}
                    className={`exitload ${l.overflow > 0 ? 'bad' : ''}`}
                    onClick={() => onLocate(l.point, { type: 'facility', id: l.facilityId })}
                    title={l.overflow > 0 ? `超出 ${l.overflow} 人，点击定位` : '点击定位'}
                  >
                    <span className={`dot ${l.overflow > 0 ? 'error' : 'ok'}`} />
                    {l.code}：{l.assigned}/{l.capacity} 人
                    {l.overflow > 0 && <b className="bad">（超 {l.overflow} 人）</b>}
                    <span className="hint"> 净宽 {l.widthM.toFixed(2)}m</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="items">
            {result.items.length === 0 && <p className="hint">无不合规项</p>}
            {result.items.map((it, i) => (
              <button
                key={i}
                className={`item ${it.severity}`}
                onClick={() => {
                  const sel = it.facilityId
                    ? { type: 'facility' as const, id: it.facilityId }
                    : it.roomId
                      ? { type: 'room' as const, id: it.roomId }
                      : undefined;
                  onLocate(it.point ?? null, sel);
                }}
              >
                <span className={`dot ${it.severity}`} />
                <span>
                  <b>{TYPE_LABELS[it.type] ?? it.type}</b> {it.message}
                </span>
              </button>
            ))}
          </div>
          <p className="hint">依据：{result.rulesSnapshot.source}（结果记录于 {new Date(result.checkedAt).toLocaleString('zh-CN')}）</p>
        </>
      )}
      {floor && (
        <p className="hint">
          楼层版本 v{floor.version} · 校验按「{rules.buildingKind}」规则 v{rules.version} 执行
        </p>
      )}
    </section>
  );
}
