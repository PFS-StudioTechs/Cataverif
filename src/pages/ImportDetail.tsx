import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/integrations/supabase/client'
import { ArrowLeft, CheckCircle2, AlertTriangle, HelpCircle, Pencil, Check, X, GitCompare, PackageMinus, PackagePlus, TrendingUp, Download, Trash2 } from 'lucide-react'

type Produit = {
  id: string
  reference: string | null
  designation: string
  unite: string
  prix_achat: number
  actif: boolean
  statut_import: 'ia' | 'valide' | 'manuel'
  image_url: string | null
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
  prix_negocie: EcartPrix[]
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
  const [compareProgress, setCompareProgress] = useState<string | null>(null)
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [selectedManquants, setSelectedManquants] = useState<Set<number>>(new Set())
  const [allProduits, setAllProduits] = useState<Produit[]>([])
  const [editIdAll, setEditIdAll] = useState<string | null>(null)
  const [editDataAll, setEditDataAll] = useState<Partial<Produit>>({})
  const [savingAll, setSavingAll] = useState(false)
  const [filterAll, setFilterAll] = useState<'tous' | 'ia' | 'valide' | 'manuel'>('tous')

  const toggleManquant = (i: number) => setSelectedManquants(prev => {
    const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n
  })
  const toggleAllManquants = (total: number) => setSelectedManquants(prev =>
    prev.size === total ? new Set() : new Set(Array.from({ length: total }, (_, i) => i))
  )

  const deleteFantome = async (id: string) => {
    await supabase.from('produits').update({ actif: false }).eq('id', id)
    setCompareResult(prev => prev ? { ...prev, fantomes: prev.fantomes.filter(f => f.id !== id) } : prev)
  }


  const handleImageUploadAll = async (productId: string, file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    const path = `product-images/manual/${productId}.${ext}`
    const { error } = await supabase.storage.from('artisan-documents').upload(path, file, { upsert: true })
    if (error) return
    const { data } = supabase.storage.from('artisan-documents').getPublicUrl(path)
    setEditDataAll(d => ({ ...d, image_url: data.publicUrl }))
  }

  const saveEditAll = async () => {
    if (!editIdAll) return
    setSavingAll(true)
    await supabase.from('produits').update({ ...editDataAll, updated_at: new Date().toISOString() }).eq('id', editIdAll)
    setAllProduits(prev => prev.map(p => p.id === editIdAll ? { ...p, ...editDataAll } as Produit : p))
    setEditIdAll(null)
    setSavingAll(false)
  }

  const deleteFromAll = async (id: string) => {
    if (!window.confirm('Supprimer cet article ?')) return
    await supabase.from('produits').update({ actif: false }).eq('id', id)
    setAllProduits(prev => prev.filter(p => p.id !== id))
  }

  const [extractingImages, setExtractingImages] = useState(false)
  const [extractMsg, setExtractMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    supabase.from('catalogue_imports').select('*, fournisseurs(nom)').eq('id', id).single()
      .then(async (impRes) => {
        const imp = impRes.data as Import
        setImp(imp)
        const [prodsRes, allProdsRes] = await Promise.all([
          supabase.from('produits').select('*').eq('import_id', id).order('designation'),
          supabase.from('produits').select('*').eq('fournisseur_id', imp.fournisseur_id).eq('actif', true).order('designation'),
        ])
        setProduits((prodsRes.data as Produit[]) ?? [])
        setAllProduits((allProdsRes.data as Produit[]) ?? [])
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
    if (!imp) return
    setComparing(true)
    setCompareError(null)
    setCompareResult(null)
    setCompareProgress(null)

    try {
      if (imp.fichier_type !== 'pdf') {
        const { data, error } = await supabase.functions.invoke('compare-catalogue', { body: { import_id: id } })
        if (error) throw new Error(error.message)
        if (!data || data.error) throw new Error(data?.error ?? 'Réponse vide')
        setCompareResult(data as CompareResult)
        return
      }

      const CHUNK = 20
      let allProduits: unknown[] = []
      let total_pages = 0

      const first = await supabase.functions.invoke('compare-catalogue', {
        body: { import_id: id, mode: 'extract', page_start: 0, page_end: CHUNK }
      })
      if (first.error) throw new Error(first.error.message)
      if (first.data?.error) throw new Error(first.data.error)
      total_pages = first.data.total_pages
      allProduits = [...first.data.produits]
      setCompareProgress(`Pages 1–${Math.min(CHUNK, total_pages)} / ${total_pages}`)

      for (let start = CHUNK; start < total_pages; start += CHUNK) {
        const end = Math.min(start + CHUNK, total_pages)
        setCompareProgress(`Pages ${start + 1}–${end} / ${total_pages}`)
        const chunk = await supabase.functions.invoke('compare-catalogue', {
          body: { import_id: id, mode: 'extract', page_start: start, page_end: end }
        })
        if (chunk.error) throw new Error(chunk.error.message)
        if (chunk.data?.error) throw new Error(chunk.data.error)
        allProduits = [...allProduits, ...chunk.data.produits]
      }

      setCompareProgress('Comparaison en cours…')
      const result = await supabase.functions.invoke('compare-catalogue', {
        body: { import_id: id, mode: 'compare', produits_pdf: allProduits }
      })
      if (result.error) throw new Error(result.error.message)
      if (result.data?.error) throw new Error(result.data.error)
      setCompareResult(result.data as CompareResult)
    } catch (e) {
      setCompareError(e instanceof Error ? e.message : 'Erreur inconnue')
    } finally {
      setComparing(false)
      setCompareProgress(null)
    }
  }

  const extractImages = async () => {
    setExtractingImages(true)
    setExtractMsg(null)
    const { data: { session } } = await supabase.auth.getSession()
    const resp = await fetch('/api/extract-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ import_id: id }),
    })
    const result = await resp.json()
    setExtractingImages(false)
    if (result.error) { setExtractMsg(`Erreur : ${result.error}`); return }
    setExtractMsg(`${result.updated} image(s) extraite(s) et liées aux articles.`)
    const { data } = await supabase.from('produits').select('*').eq('import_id', id).order('designation')
    setProduits((data as Produit[]) ?? [])
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

  const importerManquants = async (indices?: Set<number>) => {
    if (!compareResult || !imp) return
    setImporting(true)
    const toImport = indices && indices.size > 0
      ? compareResult.manquants.filter((_, i) => indices.has(i))
      : compareResult.manquants
    const rows = toImport.map(p => ({
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
    const importedIndices = indices && indices.size > 0 ? indices : null
    setCompareResult(prev => prev ? {
      ...prev,
      manquants: importedIndices
        ? prev.manquants.filter((_, i) => !importedIndices.has(i))
        : []
    } : prev)
    setSelectedManquants(new Set())
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
          onClick={extractImages}
          disabled={extractingImages || imp.fichier_type !== 'pdf'}
          className="flex items-center gap-1.5 text-sm border border-purple-300 text-purple-700 rounded-lg px-4 py-2 hover:bg-purple-50 transition-colors disabled:opacity-40"
        >
          <span>{extractingImages ? 'Extraction en cours…' : 'Extraire images'}</span>
        </button>
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
          <span>{compareProgress ?? (comparing ? 'Analyse en cours…' : 'Comparer avec fichier source')}</span>
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
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Base articles fournisseur</h2>
        <div>
            <div className="flex gap-2 mb-4">
              {(['tous', 'ia', 'valide', 'manuel'] as const).map(k => (
                <button key={k} onClick={() => setFilterAll(k)} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filterAll === k ? 'bg-blue-500 text-white border-blue-500' : 'bg-white border-gray-200 text-gray-600 hover:border-blue-300'}`}>
                  {k === 'tous' ? `Tous (${allProduits.length})` : k === 'ia' ? `IA (${allProduits.filter(p => p.statut_import === 'ia').length})` : k === 'valide' ? `Validés (${allProduits.filter(p => p.statut_import === 'valide').length})` : `Manuels (${allProduits.filter(p => p.statut_import === 'manuel').length})`}
                </button>
              ))}
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 w-12"></th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 w-24">Réf.</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">Désignation</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 w-20">Unité</th>
                      <th className="text-right px-4 py-3 font-medium text-gray-600 w-28">PA HT (€)</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600 w-36">Statut</th>
                      <th className="px-4 py-3 w-20"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {allProduits.filter(p => filterAll === 'tous' || p.statut_import === filterAll).map(p => (
                      <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                        {editIdAll === p.id ? (
                          <>
                            <td className="px-4 py-2">
                              <label className="cursor-pointer block">
                                {editDataAll.image_url
                                  ? <img src={editDataAll.image_url} alt="" className="w-8 h-8 object-cover rounded hover:opacity-70" />
                                  : <div className="w-8 h-8 border-2 border-dashed border-gray-300 rounded flex items-center justify-center text-gray-400 text-xs hover:border-blue-400">+</div>}
                                <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUploadAll(p.id, f) }} />
                              </label>
                            </td>
                            <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-xs font-mono" value={editDataAll.reference ?? ''} onChange={e => setEditDataAll(d => ({ ...d, reference: e.target.value || null }))} /></td>
                            <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-xs" value={editDataAll.designation ?? ''} onChange={e => setEditDataAll(d => ({ ...d, designation: e.target.value }))} /></td>
                            <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-xs" value={editDataAll.unite ?? ''} onChange={e => setEditDataAll(d => ({ ...d, unite: e.target.value }))} /></td>
                            <td className="px-4 py-2"><input type="number" step="0.01" className="w-full border rounded px-2 py-1 text-xs text-right" value={editDataAll.prix_achat ?? 0} onChange={e => setEditDataAll(d => ({ ...d, prix_achat: parseFloat(e.target.value) }))} /></td>
                            <td className="px-4 py-2 text-xs text-gray-400">{statutBadge(p.statut_import)}</td>
                            <td className="px-4 py-2">
                              <div className="flex gap-1 justify-end">
                                <button onClick={saveEditAll} disabled={savingAll} className="text-green-600 hover:text-green-800"><Check className="w-4 h-4" /></button>
                                <button onClick={() => setEditIdAll(null)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-4 py-3">
                              {p.image_url && <a href={p.image_url} target="_blank" rel="noreferrer"><img src={p.image_url} alt="" className="w-8 h-8 object-cover rounded hover:opacity-80" /></a>}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.reference ?? '—'}</td>
                            <td className="px-4 py-3 text-gray-900">{p.designation}</td>
                            <td className="px-4 py-3 text-gray-500">{p.unite}</td>
                            <td className="px-4 py-3 text-right font-mono">{p.prix_achat.toFixed(2)}</td>
                            <td className="px-4 py-3">{statutBadge(p.statut_import)}</td>
                            <td className="px-4 py-3">
                              <div className="flex gap-1 justify-end">
                                <button onClick={() => { setEditIdAll(p.id); setEditDataAll({ reference: p.reference, designation: p.designation, unite: p.unite, prix_achat: p.prix_achat, image_url: p.image_url }) }} className="text-gray-300 hover:text-blue-500 transition-colors"><Pencil className="w-4 h-4" /></button>
                                <button onClick={() => deleteFromAll(p.id)} className="text-gray-300 hover:text-red-500 transition-colors"><Trash2 className="w-4 h-4" /></button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                    {allProduits.length === 0 && (
                      <tr><td colSpan={6} className="text-center py-10 text-gray-400">Aucun article</td></tr>
                    )}
                  </tbody>
                </table>
            </div>
          </div>

        <div className="mt-8">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">Cet import</h2>
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
                <th className="px-4 py-3 w-12"></th>
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
                      <td className="px-4 py-2" />
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
                      <td className="px-4 py-3">
                        {p.image_url
                          ? <img src={p.image_url} alt="" className="w-8 h-8 object-cover rounded" />
                          : <div className="w-8 h-8 bg-gray-100 rounded" />}
                      </td>
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
        {extractMsg && (
          <div className={`mt-4 rounded-xl px-4 py-3 text-sm ${extractMsg.startsWith('Erreur') ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-purple-50 border border-purple-200 text-purple-700'}`}>
            {extractMsg}
          </div>
        )}

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
                      <th className="w-8 px-3 py-2"><input type="checkbox" checked={selectedManquants.size === compareResult.manquants.length && compareResult.manquants.length > 0} onChange={() => toggleAllManquants(compareResult.manquants.length)} className="cursor-pointer" /></th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-24">Réf.</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">Désignation</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-20">Unité</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-28">PA HT (€)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {compareResult.manquants.map((p, i) => (
                      <tr key={i} className={selectedManquants.has(i) ? "bg-red-100" : "bg-red-50/50"}>
                        <td className="px-3 py-2"><input type="checkbox" checked={selectedManquants.has(i)} onChange={() => toggleManquant(i)} className="cursor-pointer" /></td>
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
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {compareResult.fantomes.map((p, i) => (
                      <tr key={i} className="bg-orange-50/50">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{p.reference ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-900">{p.designation}</td>
                        <td className="px-4 py-2 text-gray-500">{p.unite}</td>
                        <td className="px-4 py-2 text-right font-mono">{p.prix_achat.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <button onClick={() => deleteFantome(p.id)} title="Supprimer de la base" className="p-1 rounded hover:bg-red-100 text-red-400 hover:text-red-600 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
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
              <div className="flex gap-2">
                <button
                  onClick={() => importerManquants(selectedManquants.size > 0 ? selectedManquants : undefined)}
                  disabled={importing}
                  className="flex items-center gap-2 bg-red-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  <PackageMinus className="w-4 h-4" />
                  {importing ? 'Import en cours…' : selectedManquants.size > 0
                    ? `Importer les ${selectedManquants.size} sélectionnés`
                    : `Importer les ${compareResult.manquants.length} manquants`}
                </button>
              </div>
            )}

            {(compareResult.prix_negocie?.length ?? 0) > 0 && (
              <div className="bg-white rounded-xl border border-blue-200 overflow-hidden">
                <div className="px-4 py-3 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-blue-500" />
                  <span className="text-sm font-semibold text-blue-700">Prix négociés ({compareResult.prix_negocie.length})</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600 w-24">Réf.</th>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">Désignation</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-28">Prix catalogue</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-28">Prix négocié</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600 w-24">Écart</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {compareResult.prix_negocie.map((e, i) => (
                      <tr key={i} className="bg-blue-50/30">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{e.reference ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-900">{e.designation}</td>
                        <td className="px-4 py-2 text-right font-mono">{e.prix_pdf.toFixed(2)}</td>
                        <td className="px-4 py-2 text-right font-mono text-blue-700 font-semibold">{e.prix_db.toFixed(2)}</td>
                        <td className="px-4 py-2 text-right font-mono text-blue-600">{e.delta > 0 ? '+' : ''}{e.delta.toFixed(2)} €</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {compareResult.manquants.length === 0 && compareResult.fantomes.length === 0 && compareResult.ecarts_prix.length === 0 && (
              <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-green-700 text-sm">
                <CheckCircle2 className="w-4 h-4" />
                <span>Import parfait — aucune anomalie.{(compareResult.prix_negocie?.length ?? 0) > 0 ? ` (${compareResult.prix_negocie.length} prix négociés — non bloquants)` : ''}</span>
              </div>
            )}
          </div>
        )}
        </div>
      </main>
    </div>
  )
}
