import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/integrations/supabase/client'
import { useAuth } from '@/hooks/useAuth'
import { ArrowLeft, Pencil, Check, X, Trash2, ChevronUp, ChevronDown, ChevronsUpDown, Plus } from 'lucide-react'

type SortField = 'fournisseur' | 'reference' | 'designation' | 'unite' | 'prix_achat' | 'statut_import'
type SortDir = 'asc' | 'desc'

type Produit = {
  id: string
  reference: string | null
  designation: string
  unite: string
  prix_achat: number
  statut_import: 'ia' | 'valide' | 'manuel'
  fournisseur_id: string
  fournisseurs: { nom: string } | null
}

const statutBadge = (s: string) => {
  if (s === 'valide') return <span className="text-xs bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">Validé</span>
  if (s === 'ia') return <span className="text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-full px-2 py-0.5">IA</span>
  return <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">Manuel</span>
}

export default function Articles() {
  const navigate = useNavigate()
  const [produits, setProduits] = useState<Produit[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'tous' | 'ia' | 'valide' | 'manuel'>('tous')
  const [fournisseurFilter, setFournisseurFilter] = useState<string>('tous')
  const [editId, setEditId] = useState<string | null>(null)
  const [editData, setEditData] = useState<Partial<Produit>>({})
  const [saving, setSaving] = useState(false)
  const [sortField, setSortField] = useState<SortField>('designation')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [doublonsOnly, setDoublonsOnly] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newData, setNewData] = useState({ fournisseur_id: '', reference: '', designation: '', unite: 'u', prix_achat: 0 })
  const [adding, setAdding] = useState(false)
  const { user } = useAuth()

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown className="w-3 h-3 inline ml-1 opacity-30" />
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3 inline ml-1" /> : <ChevronDown className="w-3 h-3 inline ml-1" />
  }

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    const { data } = await supabase
      .from('produits')
      .select('*, fournisseurs(nom)')
      .eq('actif', true)
      .order('fournisseur_id')
      .order('designation')
    setProduits((data as Produit[]) ?? [])
    setLoading(false)
  }

  const saveEdit = async () => {
    if (!editId) return
    setSaving(true)
    await supabase.from('produits').update({ ...editData, updated_at: new Date().toISOString() }).eq('id', editId)
    setProduits(prev => prev.map(p => p.id === editId ? { ...p, ...editData } as Produit : p))
    setEditId(null)
    setSaving(false)
  }

  const deleteProduit = async (id: string) => {
    if (!window.confirm('Supprimer cet article ?')) return
    await supabase.from('produits').update({ actif: false }).eq('id', id)
    setProduits(prev => prev.filter(p => p.id !== id))
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const deleteSelected = async () => {
    if (!window.confirm(`Supprimer ${selected.size} article(s) ?`)) return
    const ids = [...selected]
    for (const id of ids) await supabase.from('produits').update({ actif: false }).eq('id', id)
    setProduits(prev => prev.filter(p => !selected.has(p.id)))
    setSelected(new Set())
  }

  const addProduit = async () => {
    if (!newData.fournisseur_id || !newData.designation.trim()) return
    setAdding(true)
    const { data } = await supabase.from('produits').insert({
      artisan_id: user?.id,
      fournisseur_id: newData.fournisseur_id,
      reference: newData.reference.trim() || null,
      designation: newData.designation.trim(),
      unite: newData.unite.trim() || 'u',
      prix_achat: newData.prix_achat,
      statut_import: 'manuel',
      actif: true,
    }).select('*, fournisseurs(nom)').single()
    if (data) setProduits(prev => [...prev, data as Produit])
    setShowAddForm(false)
    setNewData({ fournisseur_id: '', reference: '', designation: '', unite: 'u', prix_achat: 0 })
    setAdding(false)
  }

  const toggleOne = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAll = (ids: string[]) => setSelected(prev => prev.size === ids.length && ids.every(id => prev.has(id)) ? new Set() : new Set(ids))

  const fournisseurs = [...new Map(produits.map(p => [p.fournisseur_id, p.fournisseurs?.nom ?? '—'])).entries()]

  const doublonIds = new Set(
    Object.values(
      produits.filter(p => p.reference).reduce((acc, p) => {
        const key = `${p.fournisseur_id}|${p.reference!.trim().toLowerCase()}`
        acc[key] = acc[key] ?? []
        acc[key].push(p.id)
        return acc
      }, {} as Record<string, string[]>)
    ).filter(ids => ids.length > 1).flat()
  )

  const filtered = produits
    .filter(p =>
      (filter === 'tous' || p.statut_import === filter) &&
      (fournisseurFilter === 'tous' || p.fournisseur_id === fournisseurFilter) &&
      (!doublonsOnly || doublonIds.has(p.id))
    )
    .sort((a, b) => {
      let va: string | number = ''
      let vb: string | number = ''
      if (sortField === 'fournisseur') { va = a.fournisseurs?.nom ?? ''; vb = b.fournisseurs?.nom ?? '' }
      else if (sortField === 'reference') { va = a.reference ?? ''; vb = b.reference ?? '' }
      else if (sortField === 'designation') { va = a.designation; vb = b.designation }
      else if (sortField === 'unite') { va = a.unite; vb = b.unite }
      else if (sortField === 'prix_achat') { va = a.prix_achat; vb = b.prix_achat }
      else if (sortField === 'statut_import') { va = a.statut_import; vb = b.statut_import }
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ? 1 : -1
      return 0
    })

  return (
    <div className="min-h-screen bg-gray-50" translate="no">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <button onClick={() => navigate('/')} className="text-gray-400 hover:text-gray-700 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="font-semibold text-gray-900 flex-1">Base articles ({produits.length})</h1>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex gap-3 mb-4 flex-wrap">
          <select value={fournisseurFilter} onChange={e => setFournisseurFilter(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white">
            <option value="tous">Tous fournisseurs</option>
            {fournisseurs.map(([id, nom]) => <option key={id} value={id}>{nom}</option>)}
          </select>
          {(['tous', 'ia', 'valide', 'manuel'] as const).map(k => (
            <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filter === k ? 'bg-blue-500 text-white border-blue-500' : 'bg-white border-gray-200 text-gray-600 hover:border-blue-300'}`}>
              {k === 'tous' ? `Tous (${produits.length})` : k === 'ia' ? `IA (${produits.filter(p => p.statut_import === 'ia').length})` : k === 'valide' ? `Validés (${produits.filter(p => p.statut_import === 'valide').length})` : `Manuels (${produits.filter(p => p.statut_import === 'manuel').length})`}
            </button>
          ))}
          <button onClick={() => { setDoublonsOnly(d => !d); setSelected(new Set()) }} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${doublonsOnly ? 'bg-orange-500 text-white border-orange-500' : 'bg-white border-orange-300 text-orange-600 hover:border-orange-500'}`}>
            Doublons {doublonsOnly ? `(${doublonIds.size})` : doublonIds.size > 0 ? `(${doublonIds.size})` : ''}
          </button>
          {selected.size > 0 && (
            <button onClick={deleteSelected} className="px-3 py-1.5 rounded-full text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50 transition-colors">
              Supprimer ({selected.size})
            </button>
          )}
          <span className="ml-auto self-center text-xs text-gray-400">{filtered.length} article{filtered.length !== 1 ? 's' : ''}</span>
          <button onClick={() => setShowAddForm(true)} disabled={showAddForm} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 transition-colors">
            <Plus className="w-3.5 h-3.5" />Ajouter
          </button>
        </div>

        {showAddForm && (
          <div className="border rounded-lg overflow-hidden bg-blue-50/50 mb-4">
            <div className="px-3 py-2 bg-blue-100 text-xs font-medium text-blue-800 border-b border-blue-200">Nouvel article manuel</div>
            <div className="flex gap-2 p-3 items-end flex-wrap">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">Fournisseur *</span>
                <select value={newData.fournisseur_id} onChange={e => setNewData(d => ({ ...d, fournisseur_id: e.target.value }))} className="h-7 text-xs border border-gray-200 rounded px-2 bg-white">
                  <option value="">— Choisir —</option>
                  {fournisseurs.map(([id, nom]) => <option key={id} value={id}>{nom}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">Référence</span>
                <input value={newData.reference} onChange={e => setNewData(d => ({ ...d, reference: e.target.value }))} className="h-7 text-xs border border-gray-200 rounded px-2 w-28" placeholder="Optionnel" />
              </div>
              <div className="flex flex-col gap-1 flex-1 min-w-40">
                <span className="text-xs text-gray-500">Désignation *</span>
                <input value={newData.designation} onChange={e => setNewData(d => ({ ...d, designation: e.target.value }))} className="h-7 text-xs border border-gray-200 rounded px-2" placeholder="Désignation" />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">Unité</span>
                <input value={newData.unite} onChange={e => setNewData(d => ({ ...d, unite: e.target.value }))} className="h-7 text-xs border border-gray-200 rounded px-2 w-16" placeholder="u" />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">PA HT (€)</span>
                <input type="number" min="0" step="0.01" value={newData.prix_achat} onChange={e => setNewData(d => ({ ...d, prix_achat: parseFloat(e.target.value) || 0 }))} className="h-7 text-xs border border-gray-200 rounded px-2 text-right w-28" />
              </div>
              <button onClick={addProduit} disabled={adding || !newData.fournisseur_id || !newData.designation.trim()} className="h-7 text-xs px-3 flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed">
                <Check className="w-3.5 h-3.5" /> Enregistrer
              </button>
              <button onClick={() => { setShowAddForm(false); setNewData({ fournisseur_id: '', reference: '', designation: '', unite: 'u', prix_achat: 0 }) }} className="h-7 text-xs px-2 flex items-center text-gray-500 hover:text-gray-700 rounded hover:bg-gray-100">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-gray-400">Chargement…</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="w-8 px-3 py-3"><input type="checkbox" checked={filtered.length > 0 && filtered.every(p => selected.has(p.id))} onChange={() => toggleAll(filtered.map(p => p.id))} className="cursor-pointer" /></th>
                  {([['fournisseur','Fournisseur','w-32','left'],['reference','Réf.','w-24','left'],['designation','Désignation','','left'],['unite','Unité','w-20','left'],['prix_achat','PA HT (€)','w-28','right'],['statut_import','Statut','w-24','left']] as [SortField,string,string,string][]).map(([f,label,w,align]) => (
                    <th key={f} onClick={() => toggleSort(f)} className={`px-4 py-3 font-medium text-gray-600 cursor-pointer hover:bg-gray-100 select-none ${w} text-${align}`}>
                      {label}<SortIcon field={f} />
                    </th>
                  ))}
                  <th className="px-4 py-3 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(p => (
                  <tr key={p.id} className={`hover:bg-gray-50 transition-colors ${selected.has(p.id) ? 'bg-blue-50' : doublonIds.has(p.id) ? 'bg-orange-50/50' : ''}`}>
                    {editId === p.id ? (
                      <>
                        <td className="px-3 py-2" />
                        <td className="px-4 py-2 text-xs text-gray-400">{p.fournisseurs?.nom ?? '—'}</td>
                        <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-xs font-mono" value={editData.reference ?? ''} onChange={e => setEditData(d => ({ ...d, reference: e.target.value || null }))} /></td>
                        <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-xs" value={editData.designation ?? ''} onChange={e => setEditData(d => ({ ...d, designation: e.target.value }))} /></td>
                        <td className="px-4 py-2"><input className="w-full border rounded px-2 py-1 text-xs" value={editData.unite ?? ''} onChange={e => setEditData(d => ({ ...d, unite: e.target.value }))} /></td>
                        <td className="px-4 py-2"><input type="number" step="0.01" className="w-full border rounded px-2 py-1 text-xs text-right" value={editData.prix_achat ?? 0} onChange={e => setEditData(d => ({ ...d, prix_achat: parseFloat(e.target.value) }))} /></td>
                        <td className="px-4 py-2">{statutBadge(p.statut_import)}</td>
                        <td className="px-4 py-2">
                          <div className="flex gap-1 justify-end">
                            <button onClick={saveEdit} disabled={saving} className="text-green-600 hover:text-green-800"><Check className="w-4 h-4" /></button>
                            <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-3"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} className="cursor-pointer" /></td>
                        <td className="px-4 py-3 text-xs text-gray-500 font-medium">{p.fournisseurs?.nom ?? '—'}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.reference ?? '—'}</td>
                        <td className="px-4 py-3 text-gray-900">{p.designation}</td>
                        <td className="px-4 py-3 text-gray-500">{p.unite}</td>
                        <td className="px-4 py-3 text-right font-mono">{p.prix_achat.toFixed(2)}</td>
                        <td className="px-4 py-3">{statutBadge(p.statut_import)}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => { setEditId(p.id); setEditData({ reference: p.reference, designation: p.designation, unite: p.unite, prix_achat: p.prix_achat }) }} className="text-gray-300 hover:text-blue-500 transition-colors"><Pencil className="w-4 h-4" /></button>
                            <button onClick={() => deleteProduit(p.id)} className="text-gray-300 hover:text-red-500 transition-colors"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="text-center py-10 text-gray-400">Aucun article</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>

    </div>
  )
}
