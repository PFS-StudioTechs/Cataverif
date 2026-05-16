import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/integrations/supabase/client'
import { signOut } from '@/hooks/useAuth'
import { ArrowLeft, PackageSearch, LogOut, RefreshCw, CheckCircle2, AlertCircle, Clock, Trash2 } from 'lucide-react'

type Import = {
  id: string
  fournisseur_id: string
  fichier_url: string
  fichier_type: string
  statut: string
  nb_produits_extraits: number | null
  erreur_message: string | null
  created_at: string
  fournisseurs: { nom: string } | null
  produits: [{ count: number }] | null
}

const statutIcon = (s: string) => {
  if (s === 'termine') return <CheckCircle2 className="w-4 h-4 text-green-500" />
  if (s === 'erreur') return <AlertCircle className="w-4 h-4 text-red-500" />
  return <Clock className="w-4 h-4 text-yellow-500" />
}

const statutLabel: Record<string, string> = {
  termine: 'Terminé',
  en_cours: 'En cours',
  erreur: 'Erreur',
}

export default function Imports() {
  const [imports, setImports] = useState<Import[]>([])
  const [loading, setLoading] = useState(true)
  const [filtreStatut, setFiltreStatut] = useState<string>("tous")
  const navigate = useNavigate()

  const deleteImport = async (imp: Import) => {
    const msg = `Supprimer cet import ${imp.fournisseurs?.nom ?? ''} ?`
    if (!window.confirm(msg)) return
    await supabase.storage.from('artisan-documents').remove([imp.fichier_url])
    await supabase.from('catalogue_imports').delete().eq('id', imp.id)
    setImports(prev => prev.filter(i => i.id !== imp.id))
  }

  const load = async () => {
    setLoading(true)
    const { data } = await supabase
      .from('catalogue_imports')
      .select('*, fournisseurs(nom), produits(count)')
      .order('created_at', { ascending: false })
    setImports((data as Import[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="min-h-screen bg-gray-50" translate="no">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <button onClick={() => navigate('/')} className="text-gray-400 hover:text-gray-700 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span className="font-semibold text-gray-900 flex-1">Imports catalogue</span>
        <button
          onClick={() => signOut()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <LogOut className="w-4 h-4" /> Déconnexion
        </button>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-gray-900">Imports catalogue</h1>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Actualiser
          </button>
        </div>
        <div className="flex gap-2 mb-6">
          {(["tous", "termine", "en_cours", "erreur"] as const).map(s => (
            <button
              key={s}
              onClick={() => setFiltreStatut(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                filtreStatut === s
                  ? s === "erreur" ? "bg-red-100 text-red-700 border-red-300"
                    : s === "termine" ? "bg-green-100 text-green-700 border-green-300"
                    : s === "en_cours" ? "bg-yellow-100 text-yellow-700 border-yellow-300"
                    : "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
              }`}
            >
              {s === "tous" ? "Tous" : statutLabel[s] ?? s}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />)}
          </div>
        ) : imports.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <PackageSearch className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Aucun import trouvé</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Fournisseur</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Fichier</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Statut</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Produits</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(filtreStatut === "tous" ? imports : imports.filter(i => i.statut === filtreStatut)).map(imp => (
                  <tr key={imp.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {imp.fournisseurs?.nom ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                      <span className="uppercase bg-gray-100 rounded px-1.5 py-0.5">{imp.fichier_type}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {statutIcon(imp.statut)}
                        <span className={imp.statut === 'erreur' ? 'text-red-600' : imp.statut === 'termine' ? 'text-green-700' : 'text-yellow-700'}>
                          {statutLabel[imp.statut] ?? imp.statut}
                        </span>
                      </div>
                      {imp.erreur_message && (
                        <p className="text-xs text-red-500 mt-0.5 truncate max-w-xs">{imp.erreur_message}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-700">
                      {imp.produits?.[0]?.count ?? imp.nb_produits_extraits ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(imp.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 justify-end">
                        <button
                          onClick={() => navigate(`/import/${imp.id}`)}
                          className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                        >
                          Vérifier →
                        </button>
                        <button
                          onClick={() => deleteImport(imp)}
                          className="text-gray-300 hover:text-red-500 transition-colors"
                          title="Supprimer cet import"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
