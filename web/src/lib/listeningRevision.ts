import { ref } from "vue";

export const listeningRevision = ref(0);

export function notifyListeningRecorded() {
  listeningRevision.value++;
}
