import { useNavigate } from 'react-router-dom'
import { GitCompare, Database, LogOut } from 'lucide-react'
import { signOut } from '@/hooks/useAuth'

export default function Home() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <span className="font-bold text-gray-900 text-lg">Cataverif</span>
        <button onClick={() => signOut()} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors">
          <LogOut className="w-4 h-4" /> Déconnexion
        </button>
      </header>

      <div className="flex-1 flex items-center justify-center gap-8 px-8">
        <button
          onClick={() => navigate('/imports')}
          className="flex flex-col items-center gap-4 bg-white border-2 border-blue-200 hover:border-blue-500 rounded-2xl p-10 w-72 shadow-sm hover:shadow-md transition-all group"
        >
          <GitCompare className="w-12 h-12 text-blue-400 group-hover:text-blue-600 transition-colors" />
          <div className="text-center">
            <div className="font-semibold text-gray-900 text-lg">Vérifier les imports</div>
            <div className="text-sm text-gray-500 mt-1">Comparer PDF source avec la base</div>
          </div>
        </button>

        <button
          onClick={() => navigate('/articles')}
          className="flex flex-col items-center gap-4 bg-white border-2 border-gray-200 hover:border-gray-500 rounded-2xl p-10 w-72 shadow-sm hover:shadow-md transition-all group"
        >
          <Database className="w-12 h-12 text-gray-400 group-hover:text-gray-600 transition-colors" />
          <div className="text-center">
            <div className="font-semibold text-gray-900 text-lg">Consulter la base articles</div>
            <div className="text-sm text-gray-500 mt-1">Voir, éditer et supprimer des articles</div>
          </div>
        </button>
      </div>
    </div>
  )
}
