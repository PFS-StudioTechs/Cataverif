import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/integrations/supabase/client'
import { ArrowLeft, CheckCircle2, AlertTriangle, HelpCircle, Pencil, Check, X, GitCompare, PackageMinus, PackagePlus, TrendingUp, Download } from 'lucide-react'

type Produit = {
  id: string
  reference: string | null
  designation: string
  unite: string
  prix_achat: number
  actif: boolean
  statut_import: 'ia' | 'valide' | 'manuel'
}

type EcartPrix = {
  reference: string | null
  designation: string
  unite_pdf: string
  unite_db: string
  prix_pdf: number
  prix_db: number
  delta: number
}

type CompareResult = {
  total_pdf: number
  total_db: number
  extraction_method?: string
  manquants: Produit[]
  fantomes: Produit[]
  ecarts_prix: EcartPrix[]
}

type Import = {
  id: string
  fichier_url: string
  fichier_type: string
  statut: string
  nb_produits_extraits: number | null
  created_at: string
  artisan_id: string
  fournisseur_id: string
  fournisseurs: { nom: string } | null
}

const statutBadge = (s: string) => {
  if (s === 'valide') return <span className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5"><CheckCircle2 className="w-3 h-3" /> Validé</span>
  if (s === 'ia') return <span className="inline-flex items-center gap-1 text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-full px-2 py-0.5"><HelpCircle className="w-3 h-3" /> IA — à réviser</span>
  return <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5"><Pencil className="w-3 h-3" /> Manuel</span>
}

export default function ImportDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [imp, setImp] = useState<Import | null>(null)
  const [produits, setProduits] = useState<Produit[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'tous' | 'ia' | 'valide' | 'manuel'>('tous')
  const [editId, setEditId] = useState<string | null>(null)
  const [editData, setEditData] = useState<Partial<Produit>>({})
  const [saving, setSaving] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase.from('catalogue_imports').select('*, fournisseurs(nom)').eq('id', id).single(),
      supabase.from('produits').select('*').eq('import_id', id).order('designation'),
    ]).then(([impRes, prodsRes]) => {
      setImp(impRes.data as Import)
      setProduits((prodsRes.data as Produit[]) ?? [])
      setLoading(false)
    })
  }, [id])

  const startEdit = (p: Produit) => {
    setEditId(p.id)
    setEditData({ reference: p.reference, designation: p.designation, unite: p.unite, prix_achat: p.prix_achat })
  }

  const cancelEdit = () => { setEditId(null); setEditData({}) }

  const saveEdit = async (p: Produit) => {
    setSaving(true)
    await supabase.from('produits').update({ ...editData, statut_import: 'valide', updated_at: new Date().toISOString() }).eq('id', p.id)
    setProduits(prev => prev.map(x => x.id === p.id ? { ...x, ...editData, statut_import: 'valide' } : x))
    setEditId(null)
    setSaving(false)
  }

  const runCompare = async () => {
    setComparing(true)
    setCompareError(null)
    setCompareResult(null)
    const { data, error } = await supabase.functions.invoke('compare-catalogue', { body: { import_id: id } })
    setComparing(false)
    if (error) { setCompareError(`Erreur fonction: ${error.message}`); return }
    if (!data) { setCompareError('Réponse vide — vérifier les logs Supabase Edge Functions'); return }
    if (data.error) { setCompareError(`Erreur serveur: ${data.error}`); return }
    setCompareResult(data as CompareResult)
  }

  const downloadCatalogue = async () => {
    if (!imp) return
    setDownloading(true)
    const { data, error } = await supabase.storage.from('artisan-documents').createSignedUrl(imp.fichier_url, 60)
    setDownloading(false)
    if (error || !data) return
    const a = document.createElement('a')
    a.href = data.signedUrl
    a.download = `catalogue-${imp.fournisseurs?.nom ?? 'import'}.${imp.fichier_type}`
    a.click()
  }

  const importerManquants = async () => {
    if (!compareResult || !imp) return
    setImporting(true)
    const rows = compareResult.manquants.map(p => ({
      artisan_id: imp.artisan_id,
      fournisseur_id: imp.fournisseur_id,
      import_id: id,
      reference: p.reference,
      designation: p.designation,
      unite: p.unite,
      prix_achat: p.prix_achat,
      statut_import: 'valide',
    }))
    if (rows.length > 0) {
      await supabase.from('produits').insert(rows)
    }
    await supabase.from('produits').update({ statut_import: 'valide', updated_at: new Date().toISOString() }).eq('import_id', id)
    const { data } = await supabase.from('produits').select('*').eq('import_id', id).order('designation')
    setProduits((data as Produit[]) ?? [])
    setCompareResult(null)
    setImporting(false)
  }

  const validateAll = async () => {
    const ids = filtered.filter(p => p.statut_import === 'ia').map(p => p.id)
    if (ids.length === 0) return
    await supabase.from('produits').update({ statut_import: 'valide', updated_at: new Date().toISOString() }).in('id', ids)
    setProduits(prev => prev.map(p => ids.includes(p.id) ? { ...p, statut_import: 'valide' } : p))
  }

  const filtered = produits.filter(p => filter === 'tous' || p.statut_import === filter)
  const counts = {
    tous: produits.length,
    ia: produits.filter(p => p.statut_import === 'ia').length,
    valide: produits.filter(p => p.statut_import === 'valide').length,
    manuel: produits.filter(p => p.statut_import === 'manuel').length,
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400">Chargement…</div>
  if (!imp) return <div className="min-h-screen flex items-center justify-center text-red-500">Import introuvable</div>

  return (
    <div className="min-h-screen bg-gray-50" translate="no">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <button onClick={() => navigate('/')} className="text-gray-400 hover:text-gray-700 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="font-semibold text-gray-900">Catalogue — {imp.fournisseurs?.nom ?? '—'}</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Import du {new Date(imp.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })} · {produits.length} produits
          </p>
        </div>
        <button
          onClick={downloadCatalogue}
          disabled={downloading}
          className="flex items-center gap-1.5 text-sm border border-gray-300 text-gray-600 rounded-lg px-4 py-2 hover:bg-gray-50 transition-colors"
        >
          <Download className="w-4 h-4" />
          <span>{downloading ? 'Téléchargement…' : 'Télécharger catalogue'}</span>
        </button>
        <button
          onClick={runCompare}
          disabled={comparing}
          className="flex items-center gap-1.5 text-sm border border-blue-300 text-blue-700 rounded-lg px-4 py-2 hover:bg-blue-50 transition-colors"
        >
          <GitCompare className={`w-4 h-4 ${comparing ? 'animate-spin' : ''}`} />
          <span>{comparing ? 'Analyse en cours…' : 'Comparer avec fichier source'}</span>
        </button>
        {counts.ia > 0 && (
          <button
            onClick={validateAll}
            className="flex items-center gap-1.5 text-sm bg-green-600 text-white rounded-lg px-4 py-2 hover:bg-green-700 transition-colors"
          >
            <CheckCircle2 className="w-4 h-4" /> Valider tout ({counts.ia})
          </button>
        )}
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          {(['tous', 'ia', 'valide', 'manuel'] as const).map(k => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`rounded-xl border p-4 text-left transition-colors ${filter === k ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
            >
              <div className="text-2xl font-bold text-gray-900">{counts[k]}</div>
              <div className="text-xs text-gray-500 mt-0.5 capitalize">
                {k === 'tous' ? 'Total' : k === 'ia' ? 'À réviser (IA)' : k === 'valide' ? 'Validés' : 'Manuels'}
              </div>
            </button>
          ))}
        </div>

        {counts.ia > 0 && (
          <div className="flex items-center gap-2 bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3 mb-4 text-sm text-yellow-800">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span><strong>{counts.ia} produits</strong> extraits par IA sont à réviser. Vérifiez les désignations et prix avant validation.</span>
          </div>
        )}

        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-24">Réf.</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Désignation</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-20">Unité</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 w-28">PA HT (€)</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 w-36">Statut</th>
                <th className="px-4 py-3 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(p => (
                <tr key={p.id} className={`hover:bg-gray-50 transition-colors ${!p.actif ? 'opacity-40' : ''}`}>
                  {editId === p.id ? (
                    <>
                      <td className="px-4 py-2">
                        <input className="w-full border rounded px-2 py-1 text-xs font-mono" value={editData.reference ?? ''} onChange={e => setEditData(d => ({ ...d, reference: e.target.value }))} />
                      </td>
                      <td className="px-4 py-2">
                        <input className="w-full border rounded px-2 py-1 text-xs" value={editData.designation ?? ''} onChange={e => setEditData(d => ({ ...d, designation: e.target.value }))} />
                      </td>
                      <td className="px-4 py-2">
                        <input className="w-full border rounded px-2 py-1 text-xs" value={editData.unite ?? ''} onChange={e => setEditData(d => ({ ...d, unite: e.target.value }))} />
                      </td>
                      <td className="px-4 py-2">
                        <input type="number" step="0.01" className="w-full border rounded px-2 py-1 text-xs text-right" value={editData.prix_achat ?? 0} onChange={e => setEditData(d => ({ ...d, prix_achat: parseFloat(e.target.value) }))} />
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-400">→ Validé</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => saveEdit(p)} disabled={saving} className="text-green-600 hover:text-green-800"><Check className="w-4 h-4" /></button>
                          <button onClick={cancelEdit} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.reference ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-900">{p.designation}</td>
                      <td className="px-4 py-3 text-gray-500">{p.unite}</td>
                      <td className="px-4 py-3 text-right font-mono text-gray-900">{p.prix_achat.toFixed(2)}</td>
                      <td className="px-4 py-3">{statutBadge(p.statut_import)}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => startEdit(p)} className="text-gray-300 hover:text-blue-500 transition-colors"><Pencil className="w-4 h-4" /></button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-gray-400">Aucun produit</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {/* Résultats de comparaison */}
        {compareError && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            Erreur : {compareError}
          </div>
        )}

        {compareResult && (
          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-4 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-4 py-2">
              <span>PDF analysé : <strong className={compareResult.total_pdf !== compareResult.total_db ? 'text-orange-600' : 'text-gray-700'}>{compareResult.total_pdf} articles</strong></span>
              <span>Base : <strong className="text-gray-700">{compareResult.total_db} articles</strong></span>
              {compareResult.extraction_method && <span className="ml-auto font-mono">{compareResult.extraction_method}</span>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className={`rounded-xl border p-4 ${compareResult.manquants.length > 0 ? 'border-red-300 bg-red-50' : 'border-green-200 bg-green-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <PackageMinus className={`w-4 h-4 ${compareResult.manquants.length > 0 ? 'text-red-500' : 'text-green-500'}`} />
                  <span className="text-sm font-medium text-gray-700">Manquants en DB</span>
                </div>
                <div className={`text-2xl font-bold ${compareResult.manquants.length > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {compareResult.manquants.length}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">dans PDF mais absents de la base</div>
              </div>
              <div className={`rounded-xl border p-4 ${compareResult.fantomes.length > 0 ? 'border-orange-300 bg-orange-50' : 'border-green-200 bg-green-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <PackagePlus className={`w-4 h-4 ${compareResult.fantomes.length > 0 ? 'text-orange-500' : 'text-green-500'}`} />
                  <span className="text-sm font-medium text-gray-700">Fantômes en DB</span>
                </div>
                <div className={`text-2xl font-bold ${compareResult.fantomes.length > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {compareResult.fantomes.length}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">en base mais absents du PDF</div>
              </div>
              <div className={`rounded-xl border p-4 ${compareResult.ecarts_prix.length > 0 ? 'border-yellow-300 bg-yellow-50' : 'border-green-200 bg-green-50'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp className={`w-4 h-4 ${compareResult.ecarts_prix.length > 0 ? 'text-yellow-500' : 'text-green-500'}`} />
                  <span className="text-sm font-medium text-gray-700">Écarts de prix</span>
                </div>
                <div className={`text-2xl font-bold ${compareResult.ecarts_prix.length > 0 ? 'text-yellow-600' : 'text-green-600'}`}>
                  {compareResult.ecarts_prix.length}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">prix différents entre PDF et base</div>
              </div>
            </div>

            {compareResult.manquants.length > 0 && (
              <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
                <div className="px-4 py-3 bg-red-50 border-b border-red-200 flex items-center gap-2">
                  <PackageMinus className="w-4 h-4 text-red-500" />
                  <span className="text-sm font-semibold text-red-700">Articles manquants en base ({compareResult.manquants.length})</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-24">Réf.</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">Désignation</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-20">Unité</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-28">PA HT (€)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {compareResult.manquants.map((p, i) => (
                      <tr key={i} className="bg-red-50/50">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{p.reference ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-900">{p.designation}</td>
                        <td className="px-4 py-2 text-gray-500">{p.unite}</td>
                        <td className="px-4 py-2 text-right font-mono">{p.prix_achat.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compareResult.fantomes.length > 0 && (
              <div className="bg-white rounded-xl border border-orange-200 overflow-hidden">
                <div className="px-4 py-3 bg-orange-50 border-b border-orange-200 flex items-center gap-2">
                  <PackagePlus className="w-4 h-4 text-orange-500" />
                  <span className="text-sm font-semibold text-orange-700">Articles fantômes en base ({compareResult.fantomes.length})</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-24">Réf.</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">Désignation</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-20">Unité</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-28">PA HT (€)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {compareResult.fantomes.map((p, i) => (
                      <tr key={i} className="bg-orange-50/50">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{p.reference ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-900">{p.designation}</td>
                        <td className="px-4 py-2 text-gray-500">{p.unite}</td>
                        <td className="px-4 py-2 text-right font-mono">{p.prix_achat.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compareResult.ecarts_prix.length > 0 && (
              <div className="bg-white rounded-xl border border-yellow-200 overflow-hidden">
                <div className="px-4 py-3 bg-yellow-50 border-b border-yellow-200 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-yellow-500" />
                  <span className="text-sm font-semibold text-yellow-700">Écarts de prix ({compareResult.ecarts_prix.length})</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-24">Réf.</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">Désignation</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-28">Prix PDF</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-28">Prix DB</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-24">Écart</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {compareResult.ecarts_prix.map((e, i) => (
                      <tr key={i} className="bg-yellow-50/50">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{e.reference ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-900">{e.designation}</td>
                        <td className="px-4 py-2 text-right font-mono">{e.prix_pdf.toFixed(2)}</td>
                        <td className="px-4 py-2 text-right font-mono">{e.prix_db.toFixed(2)}</td>
                        <td className={`px-4 py-2 text-right font-mono font-semibold ${e.delta > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {e.delta > 0 ? '+' : ''}{e.delta.toFixed(2)} €
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compareResult.manquants.length > 0 && (
              <button
                onClick={importerManquants}
                disabled={importing}
                className="flex items-center gap-2 bg-red-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                <PackageMinus className="w-4 h-4" />
                {importing ? 'Import en cours…' : `Importer les ${compareResult.manquants.length} manquants + valider tout`}
              </button>
            )}

            {compareResult.manquants.length === 0 && compareResult.fantomes.length === 0 && compareResult.ecarts_prix.length === 0 && (
              <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-green-700 text-sm">
                <CheckCircle2 className="w-4 h-4" />
                <span>Import parfait — aucune anomalie détectée entre le PDF source et la base.</span>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
