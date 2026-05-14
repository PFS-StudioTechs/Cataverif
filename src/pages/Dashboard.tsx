import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/integrations/supabase/client'
import { signOut } from '@/hooks/useAuth'
import { PackageSearch, LogOut, RefreshCw, CheckCircle2, AlertCircle, Clock } from 'lucide-react'

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

export default function Dashboard() {
  const [imports, setImports] = useState<Import[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  const load = async () => {
    setLoading(true)
    const { data } = await supabase
      .from('catalogue_imports')
      .select('*, fournisseurs(nom)')
      .order('created_at', { ascending: false })
    setImports((data as Import[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PackageSearch className="w-6 h-6 text-blue-600" />
          <span className="font-bold text-gray-900 text-lg">Cataverif</span>
        </div>
        <button
          onClick={() => signOut()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <LogOut className="w-4 h-4" /> Déconnexion
        </button>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Imports catalogue</h1>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Actualiser
          </button>
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
                {imports.map(imp => (
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
                      {imp.nb_produits_extraits ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(imp.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => navigate(`/import/${imp.id}`)}
                        className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                      >
                        Vérifier →
                      </button>
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
