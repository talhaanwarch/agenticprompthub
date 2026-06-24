import 'dotenv/config'; // loads .env before anything else
import { createApp } from './app';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
