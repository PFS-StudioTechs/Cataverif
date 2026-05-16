import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/integrations/supabase/client'
import { ArrowLeft, Pencil, Check, X, Trash2 } from 'lucide-react'

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
  }

  const fournisseurs = [...new Map(produits.map(p => [p.fournisseur_id, p.fournisseurs?.nom ?? '—'])).entries()]

  const filtered = produits.filter(p =>
    (filter === 'tous' || p.statut_import === filter) &&
    (fournisseurFilter === 'tous' || p.fournisseur_id === fournisseurFilter)
  )

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
          <span className="ml-auto self-center text-xs text-gray-400">{filtered.length} article{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        {loading ? (
          <div className="text-center py-16 text-gray-400">Chargement…</div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-32">Fournisseur</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-24">Réf.</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Désignation</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-20">Unité</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 w-28">PA HT (€)</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 w-24">Statut</th>
                  <th className="px-4 py-3 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                    {editId === p.id ? (
                      <>
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
