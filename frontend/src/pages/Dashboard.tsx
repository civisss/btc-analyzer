import {
  CycleAnalysisCard, ForecastCard, FractalCard, HistoricalCyclesCard, InsightsCard, KeyLevelsCard, KpiRow, LiqHeatmapCard, MainChartCard,
  MacroContextCard, OnChainCard, UsdtCard,
} from '../widgets/dashboard'
import { FlowsCard } from '../widgets/flows'

export default function Dashboard() {
  return (
    <div className="flex flex-col gap-3">
      <KpiRow />
      <div className="grid gap-3 xl:grid-cols-12">
        <div className="xl:col-span-12 min-[1800px]:col-span-6"><MainChartCard /></div>
        <div className="xl:col-span-6 min-[1800px]:col-span-3"><CycleAnalysisCard /></div>
        <div className="flex flex-col gap-3 md:grid md:grid-cols-2 xl:col-span-6 xl:flex min-[1800px]:col-span-3">
          <HistoricalCyclesCard />
          <KeyLevelsCard className="flex-1" />
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        <LiqHeatmapCard />
        <FractalCard />
        <UsdtCard />
        <MacroContextCard />
      </div>
      {/* one height per row: list cards spread their rows, the forecast chart fills */}
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        <OnChainCard />
        <FlowsCard />
        <InsightsCard />
        <ForecastCard />
      </div>
    </div>
  )
}
