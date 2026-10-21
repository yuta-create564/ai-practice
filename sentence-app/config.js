// 同期の設定(公開しても大丈夫な値だけを書く場所)。
// Supabase の「Project URL」と「公開用キー(Publishable key / anon key)」を入れると、
// どの端末でもアプリの設定画面で入力しなくてよくなります。空のままでも、アプリの設定画面から入力できます。
// ※ 秘密のキー(secret / service_role)は絶対にここに書かないでください。
window.EIGO_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
